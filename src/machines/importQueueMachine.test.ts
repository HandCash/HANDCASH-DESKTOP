import { createActor, waitFor } from 'xstate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImportItemResult, ImportItemsResult } from '../wallet/import'
import {
  IMPORT_CHUNK,
  importQueueMachine,
  nextChunk,
  sourceRun,
  STALE_FUNDING_PAUSE_MS,
  STALE_FUNDING_PAUSES,
  type ImportQueueEmitted,
  type ImportQueuePorts,
} from './importQueueMachine'

const op = (n: number) => `${n.toString(16).padStart(64, '0')}_0`
const MOVED: ImportItemResult = { kind: 'moved', txid: 'f'.repeat(64) }
const DEFERRED: ImportItemResult = { kind: 'deferred', message: 'A spent fee coin is being cleared.' }

type ImportMany = ImportQueuePorts['importMany']

function start(importMany: ImportMany) {
  const ports = { importMany: vi.fn(importMany), prefetch: vi.fn(async () => undefined) }
  const queue = createActor(importQueueMachine, { input: { ports } }).start()
  const answered: ImportQueueEmitted[] = []
  queue.on('answered', (event) => answered.push(event))
  return { queue, ports, answered }
}

const items = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ outpoint: op(from + i), name: `Item ${from + i}` }))

const moved: ImportMany = async ({ outpoints }) => ({
  results: outpoints.map((outpoint) => ({ outpoint, result: MOVED })),
  stopped: null,
})

afterEach(() => {
  vi.useRealTimers()
})

describe('importQueueMachine', () => {
  it('moves one source and wallet per chunk, in the order chosen, and reads the next chunk ahead', async () => {
    const { queue, ports } = start(moved)
    queue.send({ type: 'ENQUEUE', sourceId: 'a', identityKey: 'id1', items: items(1, IMPORT_CHUNK + 1) })
    queue.send({ type: 'ENQUEUE', sourceId: 'b', identityKey: 'id1', items: items(500, 2) })
    queue.send({ type: 'ENQUEUE', sourceId: 'a', identityKey: 'id1', items: items(1, 3) })
    const idle = await waitFor(queue, (s) => s.matches('idle'))
    expect(ports.importMany.mock.calls.map(([c]) => [c.sourceId, c.outpoints.length])).toEqual([
      ['a', IMPORT_CHUNK],
      ['a', 1],
      ['b', 2],
    ])
    expect(ports.prefetch.mock.calls[0]![0]).toEqual({ sourceId: 'a', outpoints: [op(IMPORT_CHUNK + 1)] })
    expect(idle.context.reports).toMatchObject({
      a: { title: `${IMPORT_CHUNK + 1} items imported` },
      b: { title: '2 items imported' },
    })
  })

  it('reports a source’s run while it moves', () => {
    const { queue } = start(() => new Promise<ImportItemsResult>(() => undefined))
    queue.send({ type: 'ENQUEUE', sourceId: 'a', identityKey: 'id1', items: items(1, IMPORT_CHUNK + 2) })
    expect(sourceRun(queue.getSnapshot().context, 'a')).toMatchObject({
      total: IMPORT_CHUNK + 2,
      done: 0,
      waiting: [op(IMPORT_CHUNK + 1), op(IMPORT_CHUNK + 2)],
      stopping: false,
    })
    expect(sourceRun(queue.getSnapshot().context, 'b')).toBeNull()
  })

  it('waits out a spent fee coin, then retries only the untried items', async () => {
    vi.useFakeTimers()
    let calls = 0
    const { queue, ports, answered } = start(async ({ outpoints }) => {
      calls += 1
      if (calls === 1) {
        return {
          results: outpoints.map((outpoint, i) => ({ outpoint, result: i === 0 ? MOVED : DEFERRED })),
          stopped: 'stale-funding',
        }
      }
      return moved({ sourceId: 'a', identityKey: 'id1', outpoints })
    })
    queue.send({ type: 'ENQUEUE', sourceId: 'a', identityKey: 'id1', items: items(1, 3) })
    await vi.waitFor(() => expect(queue.getSnapshot().matches('cooling')).toBe(true))
    expect(answered.map((a) => a.results.map((r) => r.outpoint))).toEqual([[op(1)]])
    expect(sourceRun(queue.getSnapshot().context, 'a')).toMatchObject({ moving: [op(2), op(3)], done: 1 })

    await vi.advanceTimersByTimeAsync(STALE_FUNDING_PAUSE_MS)
    await vi.waitFor(() => expect(queue.getSnapshot().matches('idle')).toBe(true))
    expect(ports.importMany.mock.calls.map(([c]) => c.outpoints)).toEqual([[op(1), op(2), op(3)], [op(2), op(3)]])
    expect(queue.getSnapshot().context.reports.a).toMatchObject({ title: '3 items imported' })
  })

  it('drops the wallet’s waiting items once the fee coin pauses run out', async () => {
    vi.useFakeTimers()
    const { queue, ports } = start(async ({ outpoints }) => ({
      results: outpoints.map((outpoint) => ({ outpoint, result: DEFERRED })),
      stopped: 'stale-funding',
    }))
    queue.send({ type: 'ENQUEUE', sourceId: 'a', identityKey: 'id1', items: items(1, 2) })
    queue.send({ type: 'ENQUEUE', sourceId: 'b', identityKey: 'id1', items: items(9, 1) })
    for (let i = 0; i < STALE_FUNDING_PAUSES; i++) {
      await vi.waitFor(() => expect(queue.getSnapshot().matches('cooling')).toBe(true))
      await vi.advanceTimersByTimeAsync(STALE_FUNDING_PAUSE_MS)
    }
    await vi.waitFor(() => expect(queue.getSnapshot().matches('idle')).toBe(true))
    expect(ports.importMany).toHaveBeenCalledTimes(STALE_FUNDING_PAUSES + 1)
    expect(queue.getSnapshot().context.reports.a).toMatchObject({ outcome: 'deferred', body: expect.stringMatching(/^0 of 2 imported/) })
    expect(queue.getSnapshot().context.reports.b).toMatchObject({
      outcome: 'deferred',
      body: expect.stringMatching(/^0 of 1 imported\. A spent fee coin/),
    })
  })

  it('stopping a paused source drops its paused chunk too', async () => {
    vi.useFakeTimers()
    const { queue, ports } = start(async ({ outpoints }) => ({
      results: outpoints.map((outpoint) => ({ outpoint, result: DEFERRED })),
      stopped: 'stale-funding',
    }))
    queue.send({ type: 'ENQUEUE', sourceId: 'a', identityKey: 'id1', items: items(1, 2) })
    await vi.waitFor(() => expect(queue.getSnapshot().matches('cooling')).toBe(true))
    queue.send({ type: 'STOP', sourceId: 'a' })
    expect(queue.getSnapshot().matches('idle')).toBe(true)
    expect(queue.getSnapshot().context.reports.a).toMatchObject({ title: 'Import stopped', body: '0 of 2 imported.' })
    await vi.advanceTimersByTimeAsync(STALE_FUNDING_PAUSE_MS)
    expect(ports.importMany).toHaveBeenCalledTimes(1)
  })

  it('drops every waiting item of a wallet that is no longer open', async () => {
    const changed = Object.assign(new Error('That wallet is locked now'), { name: 'ImportWalletChangedError' })
    const { queue, ports } = start(async ({ identityKey, outpoints }) => {
      if (identityKey === 'old') throw changed
      return moved({ sourceId: 'c', identityKey, outpoints })
    })
    queue.send({ type: 'ENQUEUE', sourceId: 'a', identityKey: 'old', items: items(1, 1) })
    queue.send({ type: 'ENQUEUE', sourceId: 'b', identityKey: 'old', items: items(2, 1) })
    queue.send({ type: 'ENQUEUE', sourceId: 'c', identityKey: 'new', items: items(3, 1) })
    const idle = await waitFor(queue, (s) => s.matches('idle'))
    expect(ports.importMany.mock.calls.map(([c]) => c.sourceId)).toEqual(['a', 'c'])
    expect(idle.context.reports).toMatchObject({
      a: { tone: 'danger', body: 'That wallet is locked now' },
      b: { tone: 'danger', body: 'That wallet is locked now' },
      c: { tone: 'success' },
    })
  })

  it('ignores an item chosen twice and lets a finished source’s report go', async () => {
    const { queue, ports } = start(moved)
    queue.send({ type: 'ENQUEUE', sourceId: 'a', identityKey: 'id1', items: [...items(1, 2), ...items(1, 1)] })
    queue.send({ type: 'ENQUEUE', sourceId: 'a', identityKey: 'id1', items: items(2, 1) })
    await waitFor(queue, (s) => s.matches('idle'))
    expect(ports.importMany.mock.calls.map(([c]) => c.outpoints)).toEqual([[op(1), op(2)]])
    queue.send({ type: 'DISMISS', sourceId: 'a' })
    expect(queue.getSnapshot().context.reports.a).toBeUndefined()
  })

  it('chunks by the head entry’s source and wallet', () => {
    const e = (sourceId: string, identityKey: string, n: number) => ({ sourceId, identityKey, outpoint: op(n) })
    expect(nextChunk([e('a', 'k', 1), e('b', 'k', 2), e('a', 'j', 3), e('a', 'k', 4)])).toEqual([e('a', 'k', 1), e('a', 'k', 4)])
    expect(nextChunk([])).toEqual([])
  })
})
