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
    expect(getWalletProgress()).toMatchObject({ kind: 'item-import', status: 'running', current: 200, total: 250 })
    release()
    await vi.waitFor(() => expect(getWalletProgress()).toMatchObject({ kind: 'item-import', status: 'done' }))
  })
})
