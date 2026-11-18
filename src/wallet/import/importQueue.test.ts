import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportItemsResult } from './items'

vi.mock('../appLog', () => ({ appendAppLog: vi.fn() }))
const runtime = { instance: { identityKey: 'id1', accountIndex: 0, chain: 'main' as const } as { identityKey: string; accountIndex: number; chain: 'main' | 'test' } | null }
vi.mock('../walletRuntime', () => ({ getWalletRuntime: () => runtime }))
const disk = new Map<string, string>()
vi.mock('../durableStorage', () => ({
  durableGetItem: (key: string) => disk.get(key) ?? null,
  durableSetItem: (key: string, value: string) => { disk.set(key, value); return true },
}))
vi.mock('./items', () => ({
  ImportWalletChangedError: class extends Error {},
  importItems: vi.fn(), prefetchImportItems: vi.fn(async () => undefined),
}))

import {
  bindWalletProgressAccount,
  finishWalletProgress,
  getWalletProgress,
  resetWalletProgressForTests,
  startWalletProgress,
} from '../walletProgress'
import { listWalletJobs, resetWalletJobsForTests } from '../walletJobs'
import { enqueueImportItems, importSourceView, resetImportQueueForTests, watchImportSource } from './importQueue'
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

beforeEach(() => {
  disk.clear()
  runtime.instance = { identityKey: 'id1', accountIndex: 0, chain: 'main' }
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
      owner: { identityKey: 'id1', accountIndex: 0, chain: 'main' },
      outpoints: [op(1), op(2), op(3)],
      activityGroup: job!.id,
      onLanded: expect.any(Function),
    })
    expect(getWalletProgress()).toMatchObject({ kind: 'item-import', status: 'running', current: 0, total: 3 })
    // The chunk's first transaction broadcasts while the rest still sign.
    vi.mocked(importItems).mock.calls[0]![0].onLanded!([op(1), op(2)])
    expect(getWalletProgress()).toMatchObject({ status: 'running', current: 2, total: 3, message: '2 of 3 imported' })
    expect(listWalletJobs('id1')[0]).toMatchObject({ progress: { value: 2, max: 3 } })
    release()
    await vi.waitFor(() => expect(getWalletProgress().status).toBe('done'))
    expect(listWalletJobs('id1')).toEqual([expect.objectContaining({ id: job!.id, face: 'done', progress: { value: 3, max: 3 } })])
    expect(getWalletProgress()).toMatchObject({ kind: 'item-import', message: 'Items imported' })
    expect(answered).toEqual([[op(1), op(2), op(3)]])
    expect(importSourceView('s1').report).toMatchObject({ title: '3 items imported' })
    stop()
  })

  it('replays an interrupted chunk once after restart, retaining offline work', async () => {
    vi.mocked(importItems).mockRejectedValueOnce(new Error('offline'))
    enqueueImportItems('s1', items(3))
    await vi.waitFor(() => expect(importSourceView('s1').report).not.toBeNull())
    resetImportQueueForTests()
    const release = heldChunks()
    importSourceView('s1')
    expect(importItems).toHaveBeenCalledTimes(2)
    // Repeated subscriptions/readers cannot start another chunk.
    importSourceView('s1')
    expect(importItems).toHaveBeenCalledTimes(2)
    release()
    await vi.waitFor(() => expect(getWalletProgress().status).toBe('done'))
    resetImportQueueForTests()
    importSourceView('s1')
    expect(importItems).toHaveBeenCalledTimes(2)
  })

  it('does not restore another account or chain, and returns to the original work', () => {
    heldChunks()
    enqueueImportItems('s1', items(3))
    resetImportQueueForTests()
    runtime.instance = { identityKey: 'id1', accountIndex: 1, chain: 'main' }
    importSourceView('s1')
    runtime.instance = { identityKey: 'id1', accountIndex: 0, chain: 'test' }
    importSourceView('s1')
    expect(importItems).toHaveBeenCalledTimes(1)
    runtime.instance = { identityKey: 'id1', accountIndex: 0, chain: 'main' }
    importSourceView('s1')
    expect(importItems).toHaveBeenCalledTimes(2)
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
    expect(getWalletProgress()).toMatchObject({ kind: 'item-import', status: 'running', current: 200, total: 250 })
    release()
    await vi.waitFor(() => expect(getWalletProgress()).toMatchObject({ kind: 'item-import', status: 'done' }))
  })
})
