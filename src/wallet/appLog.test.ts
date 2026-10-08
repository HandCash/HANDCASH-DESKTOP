import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
  durableRemoveItem: (key: string) => {
    store.delete(key)
  },
}))

vi.mock('../version', () => ({ APP_VERSION: '9.9.9' }))

const CURRENT_KEY = 'handcash.applog.current.v1'

/** installAppLogCapture is browser-only; this suite runs on the node env. */
function stubBrowserGlobals(): void {
  vi.stubGlobal('window', { addEventListener: () => {} })
  vi.stubGlobal('document', {
    addEventListener: () => {},
    visibilityState: 'visible',
  })
  vi.stubGlobal('navigator', { userAgent: 'test-agent' })
  vi.stubGlobal('performance', {})
}

describe('appLog crash recovery', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('mirrors errors to durable storage immediately', async () => {
    const log = await import('./appLog')
    log.appendAppLog('error', 'boom')

    const stored = JSON.parse(store.get(CURRENT_KEY) ?? '[]') as { message: string }[]
    expect(stored.map((e) => e.message)).toContain('boom')
  })

  it('recovers the last run as the previous session', async () => {
    store.set(
      CURRENT_KEY,
      JSON.stringify([{ at: 1, level: 'error', message: 'died here' }]),
    )
    stubBrowserGlobals()

    const log = await import('./appLog')
    log.installAppLogCapture()

    expect(log.getPreviousSessionLogs().map((e) => e.message)).toEqual(['died here'])
    // The recovered run must not be mistaken for this run's output.
    expect(log.getAppLogs().some((e) => e.message === 'died here')).toBe(false)
  })

  it('reports the running version so a crash can be pinned to a build', async () => {
    stubBrowserGlobals()

    const log = await import('./appLog')
    log.installAppLogCapture()

    expect(log.formatAppLogs()).toContain('v9.9.9')
  })

  it('survives a corrupt stored blob', async () => {
    store.set(CURRENT_KEY, '{not json')
    stubBrowserGlobals()

    const log = await import('./appLog')
    log.installAppLogCapture()

    expect(log.getPreviousSessionLogs()).toEqual([])
  })
})

describe('long animation frame attribution', () => {
  it('names the scripts that held the thread, longest first', async () => {
    const { describeLongFrame } = await import('./appLog')
    const line = describeLongFrame(
      {
        duration: 4076,
        blockingDuration: 3910,
        scripts: [
          { duration: 400, invoker: 'TimerHandler:setTimeout', sourceURL: 'https://localhost/assets/index-DX7vznZ3.js', sourceFunctionName: 'tick', sourceCharPosition: 10 },
          { duration: 3200, invoker: 'IDBRequest.onsuccess', sourceURL: 'https://localhost/assets/collectables-AbC123de.js?x=1', sourceFunctionName: 'mergeRows', sourceCharPosition: 5120, forcedStyleAndLayoutDuration: 120 },
        ],
      },
      ' · active: chainIngest',
    )
    expect(line).toBe(
      '[loaf] 4076ms blocking 3910ms — 3200ms mergeRows@collectables:5120 via IDBRequest.onsuccess · 400ms tick@index:10 via TimerHandler:setTimeout · non-script 476ms · forced layout 120ms · active: chainIngest',
    )
  })

  it('says so when no script is attributed — rendering or native work held the frame', async () => {
    const { describeLongFrame } = await import('./appLog')
    expect(describeLongFrame({ duration: 1200, scripts: [] })).toBe(
      '[loaf] 1200ms — no script attributed · non-script 1200ms',
    )
  })

  it('keeps dev source names and counts what it does not show', async () => {
    const { describeLongFrame } = await import('./appLog')
    const scripts = [1, 2, 3, 4, 5].map((n) => ({
      duration: n * 100,
      sourceURL: `http://localhost:5173/src/wallet/w${n}.ts?t=9`,
    }))
    expect(describeLongFrame({ duration: 1600, scripts })).toBe(
      '[loaf] 1600ms — 500ms anonymous@w5 · 400ms anonymous@w4 · 300ms anonymous@w3 · +2 more · non-script 100ms',
    )
  })
})
