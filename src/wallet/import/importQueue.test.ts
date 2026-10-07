import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportItemsResult } from './items'

vi.mock('../appLog', () => ({ appendAppLog: vi.fn() }))
const runtime = { instance: { identityKey: 'id1' } as { identityKey: string } | null }
vi.mock('../walletRuntime', () => ({ getWalletRuntime: () => runtime }))
vi.mock('./items', () => ({ importItems: vi.fn(), prefetchImportItems: vi.fn(async () => undefined) }))

import {
  bindWalletProgressAccount,
  finishWalletProgress,
  getWalletProgress,
  resetWalletProgressForTests,
  startWalletProgress,
} from '../walletProgress'
import { beginWalletJob, listWalletJobs, resetWalletJobsForTests } from '../walletJobs'
import {
  enqueueImportItems,
  importItemsThroughQueue,
  importSourceView,
  resetImportQueueForTests,
  watchImportSource,
} from './importQueue'
import { importItems } from './items'

const op = (n: number) => `${n.toString(16).padStart(64, '0')}_0`
const items = (count: number) => Array.from({ length: count }, (_, i) => ({ outpoint: op(i + 1), name: null }))

/** Hold each chunk until the test releases it. */
function heldChunks() {
  const releases: Array<() => void> = []
  vi.mocked(importItems).mockImplementation(
    ({ outpoints }) =>
      new Promise<ImportItemsResult>((resolve) => {
        releases.push(() =>
          resolve({ results: outpoints.map((outpoint) => ({ outpoint, result: { kind: 'moved', txid: 'f'.repeat(64) } })), stopped: null }),
        )
      }),
  )
  return () => releases.shift()?.()
}

/** Release chunk `from` through `last`, each once the queue has handed it over. */
async function releaseThrough(release: () => void, last: number, from = 1) {
  for (let call = from; call <= last; call++) {
    await vi.waitFor(() => expect(importItems).toHaveBeenCalledTimes(call))
    release()
  }
}

beforeEach(() => {
  runtime.instance = { identityKey: 'id1' }
  resetWalletProgressForTests()
  bindWalletProgressAccount({ identityKey: 'id1', accountIndex: 0 })
  resetImportQueueForTests()
  resetWalletJobsForTests()
  vi.mocked(importItems).mockReset()
})

afterEach(() => {
  resetImportQueueForTests()
})

describe('importQueue', () => {
  it('refuses to queue for a locked wallet', () => {
    runtime.instance = null
    expect(() => enqueueImportItems('s1', items(1))).toThrow('Unlock this wallet first')
    expect(importSourceView('s1').run).toBeNull()
  })

  it('shows the run on the status pill and finishes it', async () => {
    const release = heldChunks()
    const answered: string[][] = []
    const stop = watchImportSource('s1', () => undefined, (results) => answered.push(results.map((r) => r.outpoint)))
    enqueueImportItems('s1', items(3))
    const [job] = listWalletJobs('id1')
    expect(job).toMatchObject({ kind: 'item-import', face: 'running', progress: { value: 0, max: 3 } })
    expect(importItems).toHaveBeenCalledWith({
      sourceId: 's1',
      identityKey: 'id1',
      outpoints: [op(1), op(2), op(3)],
      activityGroup: job!.id,
      onProgress: expect.any(Function),
      onWaiting: expect.any(Function),
    })
    expect(getWalletProgress()).toMatchObject({ kind: 'item-import', status: 'running', current: 0, total: 3 })
    release()
    await vi.waitFor(() => expect(getWalletProgress().status).toBe('done'))
    expect(listWalletJobs('id1')).toEqual([expect.objectContaining({ id: job!.id, face: 'done', progress: { value: 3, max: 3 } })])
    expect(getWalletProgress()).toMatchObject({ kind: 'item-import', message: 'Items imported' })
    expect(answered).toEqual([[op(1), op(2), op(3)]])
    expect(importSourceView('s1').report).toMatchObject({ title: '3 items imported' })
    stop()
  })

  it('steps aside for a Refresh and takes the pill back once it ends', async () => {
    const release = heldChunks()
    const many = Array.from({ length: 250 }, (_, i) => ({ outpoint: op(i + 1), name: null }))
    enqueueImportItems('s1', many)
    startWalletProgress({ kind: 'refresh', phase: 'scanning', identityKey: 'id1' })
    release()
    await vi.waitFor(() => expect(importItems).toHaveBeenCalledTimes(2))
    expect(getWalletProgress()).toMatchObject({ kind: 'refresh', status: 'running' })

    finishWalletProgress('done', { identityKey: 'id1' })
    release()
    await vi.waitFor(() => expect(importItems).toHaveBeenCalledTimes(3))
    expect(getWalletProgress()).toMatchObject({ kind: 'item-import', status: 'running', current: 20, total: 250 })
    // 250 items move as 5, 15, 40, 100, 90.
    await releaseThrough(release, 5, 3)
    await vi.waitFor(() => expect(getWalletProgress()).toMatchObject({ kind: 'item-import', status: 'done' }))
  })

  it('moves the bar as each transaction lands, not only when the chunk answers', async () => {
    const release = heldChunks()
    enqueueImportItems('s1', items(30))
    const { onProgress } = vi.mocked(importItems).mock.calls[0]![0]
    onProgress!(1)
    onProgress!(1)
    expect(listWalletJobs('id1')[0]).toMatchObject({ progress: { value: 2, max: 30 } })
    expect(getWalletProgress()).toMatchObject({ current: 2, total: 30 })
    // 30 items move as 5, 15, 10.
    await releaseThrough(release, 3)
    await vi.waitFor(() => expect(listWalletJobs('id1')[0]).toMatchObject({ face: 'done', progress: { value: 30, max: 30 } }))
  })
})

describe('importItemsThroughQueue', () => {
  it('moves a sweep’s items on the sweep’s row and leaves ending it to the sweep', async () => {
    const release = heldChunks()
    const sweep = beginWalletJob({ kind: 'wallet-sweep', identityKey: 'id1' })
    const done = importItemsThroughQueue({ sourceId: 's1', outpoints: items(3).map((i) => i.outpoint), job: sweep })
    expect(vi.mocked(importItems).mock.calls[0]![0]).toMatchObject({ activityGroup: sweep.id })
    expect(listWalletJobs('id1').map((j) => j.kind)).toEqual(['wallet-sweep'])
    await releaseThrough(release, 1)
    await expect(done).resolves.toMatchObject({ moved: 3, failed: 0, report: { tone: 'success' } })
    expect(listWalletJobs('id1')).toEqual([expect.objectContaining({ kind: 'wallet-sweep', face: 'running' })])
  })

  it('answers paused with the queue’s verdict when the wallet runs out of fee', async () => {
    vi.mocked(importItems).mockResolvedValue({
      results: [
        { outpoint: op(1), result: { kind: 'moved', txid: 'f'.repeat(64) } },
        { outpoint: op(2), result: { kind: 'funds', message: 'Add BSV.' } },
      ],
      stopped: 'funds',
    })
    const sweep = beginWalletJob({ kind: 'wallet-sweep', identityKey: 'id1' })
    const outcome = await importItemsThroughQueue({ sourceId: 's1', outpoints: [op(1), op(2)], job: sweep })
    expect(outcome).toMatchObject({ moved: 1, report: { outcome: 'funds' } })
  })

  it('stops the source’s waiting items when the sweep stops', async () => {
    const release = heldChunks()
    let stopping = false
    const sweep = beginWalletJob({ kind: 'wallet-sweep', identityKey: 'id1' })
    const done = importItemsThroughQueue({
      sourceId: 's1',
      outpoints: items(30).map((i) => i.outpoint),
      job: sweep,
      shouldStop: () => stopping,
    })
    stopping = true
    await releaseThrough(release, 1)
    const outcome = await done
    expect(outcome.moved).toBe(5)
    expect(importItems).toHaveBeenCalledTimes(1)
  })

  it('resolves at once with nothing to move', async () => {
    const sweep = beginWalletJob({ kind: 'wallet-sweep', identityKey: 'id1' })
    await expect(importItemsThroughQueue({ sourceId: 's1', outpoints: [], job: sweep })).resolves.toEqual({
      moved: 0,
      skipped: 0,
      failed: 0,
      error: null,
      report: null,
    })
    expect(importItems).not.toHaveBeenCalled()
  })
})
