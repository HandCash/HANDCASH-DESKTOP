import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  callerModule,
  listCallLabel,
  resetStorageLockTraceForTests,
  traceStorageLocks,
  withStorageLockLabel,
} from './storageLockTrace'

/** The toolbox `WalletStorageManager` lock, reduced to its shape. */
class FakeManager {
  readerLocks: Array<() => void> = []
  async getActiveLock(queue: Array<() => void>): Promise<void> {
    let resolveNew = () => {}
    const lock = new Promise<void>((resolve) => {
      resolveNew = resolve
      queue.push(resolve)
    })
    if (queue.length === 1) resolveNew()
    await lock
  }
  releaseActiveLock(queue: Array<() => void>): void {
    queue.shift()
    if (queue.length > 0) queue[0]!()
  }
  async _run<T>(body: (a: unknown) => Promise<T>): Promise<T> {
    try {
      await this.getActiveLock(this.readerLocks)
      return await body({})
    } finally {
      this.releaseActiveLock(this.readerLocks)
    }
  }
  async runAsReader<T>(body: (a: unknown) => Promise<T>): Promise<T> {
    return this._run(body)
  }
  async runAsWriter<T>(body: (a: unknown) => Promise<T>): Promise<T> {
    return this._run(body)
  }
  async runAsStorageProvider<T>(body: (a: unknown) => Promise<T>): Promise<T> {
    return this._run(body)
  }
  async getAuth(): Promise<{ userId: number }> {
    return { userId: 1 }
  }
  async createAction(work: () => Promise<void>): Promise<void> {
    return await this.runAsWriter(async () => work())
  }
  async listOutputs(work: () => Promise<void>): Promise<void> {
    await this.getAuth()
    return await this.runAsReader(async () => work())
  }
  get isReady(): boolean {
    throw new Error('accessor must not run at install')
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('storage lock trace', () => {
  let info: ReturnType<typeof vi.spyOn>
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.useFakeTimers()
    resetStorageLockTraceForTests()
    info = vi.spyOn(console, 'info').mockImplementation(() => {})
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    info.mockRestore()
    warn.mockRestore()
  })

  const lines = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.startsWith('[storage-lock]'))

  it('names a long hold by the manager method that took the lock', async () => {
    const m = new FakeManager()
    traceStorageLocks(m)
    const done = m.createAction(() => sleep(1_500))
    await vi.advanceTimersByTimeAsync(1_500)
    await done
    expect(lines(info)).toEqual(['[storage-lock] createAction held 1500ms — 0 waiting'])
  })

  it('keeps the label across the getAuth await readers make first', async () => {
    const m = new FakeManager()
    traceStorageLocks(m)
    const done = m.listOutputs(() => sleep(1_200))
    await vi.advanceTimersByTimeAsync(1_200)
    await done
    expect(lines(info)).toEqual(['[storage-lock] listOutputs held 1200ms — 0 waiting'])
  })

  it('says who a long wait sat behind', async () => {
    const m = new FakeManager()
    traceStorageLocks(m)
    const holder = m.createAction(() => sleep(3_000))
    const waiter = m.listOutputs(async () => {})
    await vi.advanceTimersByTimeAsync(3_000)
    await Promise.all([holder, waiter])
    expect(lines(info)).toContain('[storage-lock] createAction held 3000ms — 1 waiting')
    expect(lines(info)).toContain('[storage-lock] listOutputs waited 3000ms behind createAction 3000ms')
  })

  it('reports a hold that never ends while it is still running', async () => {
    const m = new FakeManager()
    traceStorageLocks(m)
    void m.createAction(() => new Promise(() => {}))
    void m.listOutputs(async () => {})
    await vi.advanceTimersByTimeAsync(40_000)
    expect(lines(warn)).toEqual([
      '[storage-lock] createAction still held 10000ms — 1 waiting',
      '[storage-lock] createAction still held 40000ms — 1 waiting',
    ])
  })

  it('takes an explicit label for direct runAs calls from app code', async () => {
    const m = new FakeManager()
    traceStorageLocks(m)
    const done = withStorageLockLabel('tx-closure', () =>
      m.runAsStorageProvider(async () => sleep(1_000)),
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await done
    expect(lines(info)).toEqual(['[storage-lock] tx-closure held 1000ms — 0 waiting'])
  })

  it('names a slow Monitor task and lends it to the lock calls it makes', async () => {
    const m = new FakeManager()
    const monitor = {
      async runScheduledTask(_task: { name: string }) {
        await m.runAsStorageProvider(async () => sleep(1_100))
      },
    }
    traceStorageLocks(m, monitor)
    const done = monitor.runScheduledTask({ name: 'CheckForProofs' })
    await vi.advanceTimersByTimeAsync(1_100)
    await done
    expect(lines(info)).toEqual(['[storage-lock] monitor:CheckForProofs held 1100ms — 0 waiting'])
    expect(info.mock.calls.map((c: unknown[]) => String(c[0]))).toContain('[monitor] CheckForProofs done 1100ms')
  })

  it('does not lend a running Monitor task name to a call made outside it', async () => {
    const m = new FakeManager()
    let release!: () => void
    const monitor = {
      async runScheduledTask(_task: { name: string }) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      },
    }
    traceStorageLocks(m, monitor)
    const task = monitor.runScheduledTask({ name: 'ReviewStatus' })
    const outside = (async function itemSendPostSign() {
      await m.runAsStorageProvider(async () => sleep(1_200))
    })()
    await vi.advanceTimersByTimeAsync(1_200)
    await outside
    release()
    await task
    const held = lines(info).find((l) => l.includes('held 1200ms'))
    expect(held).toBeDefined()
    expect(held).not.toContain('monitor:')
  })

  it('stays silent for quick work and installs once', async () => {
    const m = new FakeManager()
    traceStorageLocks(m)
    traceStorageLocks(m)
    const done = m.createAction(() => sleep(10))
    await vi.advanceTimersByTimeAsync(10)
    await done
    expect(lines(info)).toEqual([])
  })
})

describe('caller module from a stack', () => {
  it('reads a built chunk name without its hash', () => {
    const stack = [
      'Error',
      '    at takeLabel (https://localhost/assets/session-Bq2x9k1A.js:1:100)',
      '    at traceRunner (https://localhost/assets/session-Bq2x9k1A.js:1:200)',
      '    at failOrphans (https://localhost/assets/localTxClosure-C8dE1fGh.js:4:5000)',
    ].join('\n')
    expect(callerModule(stack)).toBe('localTxClosure')
  })

  it('reads a dev source path', () => {
    const stack = [
      'Error',
      '    at takeLabel (http://localhost:5173/src/wallet/storageLockTrace.ts?t=1:60:20)',
      '    at traceRunner (http://localhost:5173/src/wallet/storageLockTrace.ts?t=1:90:20)',
      '    at http://localhost:5173/src/wallet/staleOutputRelease.ts:685:40',
    ].join('\n')
    expect(callerModule(stack)).toBe('staleOutputRelease')
  })

  it('gives up on a stack it cannot read', () => {
    expect(callerModule(undefined)).toBeNull()
    expect(callerModule('Error')).toBeNull()
  })
})

describe('list call label', () => {
  it('names the basket and per-row cost a read asked for', () => {
    expect(
      listCallLabel('listOutputs', {
        basket: '1sat',
        tags: [],
        includeLockingScripts: true,
        includeCustomInstructions: false,
        limit: 1000,
        offset: 0,
      }),
    ).toBe('listOutputs(basket=1sat scripts limit=1000)')
    expect(
      listCallLabel('listOutputs', { basket: '893b7646de0e1c9f741bd6e9169b76a8847ae34adef7bef1e6a285371206d2e8', tags: ['x'] }),
    ).toBe('listOutputs(basket=893b7646 tags=1)')
    expect(listCallLabel('listActions', undefined)).toBe('listActions')
  })
})
