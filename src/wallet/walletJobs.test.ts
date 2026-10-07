import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createActor } from 'xstate'
import { walletJobMachine, walletJobProgress } from '../machines/walletJobMachine'
import {
  beginWalletJob,
  listWalletJobs,
  resetWalletJobsForTests,
  subscribeWalletJobs,
  walletJobCount,
  walletJobIds,
  walletJobTitle,
} from './walletJobs'

beforeEach(() => {
  vi.useFakeTimers()
  resetWalletJobsForTests()
})

afterEach(() => {
  resetWalletJobsForTests()
  vi.useRealTimers()
})

describe('walletJobMachine', () => {
  const start = (total: number | null = null) => {
    const actor = createActor(walletJobMachine, { input: { id: 'job:x:1', kind: 'item-import', identityKey: 'id1', total } })
    actor.start()
    return actor
  }

  it('runs indeterminate until it has a total, then clamps the bar to it', () => {
    const actor = start()
    expect(walletJobProgress(actor.getSnapshot())).toBeNull()
    actor.send({ type: 'PROGRESS', current: 12, total: 10 })
    expect(walletJobProgress(actor.getSnapshot())).toEqual({ value: 10, max: 10 })
    actor.send({ type: 'PROGRESS', current: 3, total: null, detail: 'Reconciling' })
    expect(walletJobProgress(actor.getSnapshot())).toBeNull()
    expect(actor.getSnapshot().context.detail).toBe('Reconciling')
  })

  it('waits, resumes on progress, and fills the bar when done', () => {
    const actor = start(4)
    actor.send({ type: 'WAIT', detail: 'Fee coin clearing' })
    expect(actor.getSnapshot().value).toBe('waiting')
    actor.send({ type: 'PROGRESS', current: 2, total: 4 })
    expect(actor.getSnapshot().value).toBe('running')
    actor.send({ type: 'FINISH' })
    expect(actor.getSnapshot().status).toBe('done')
    expect(walletJobProgress(actor.getSnapshot())).toEqual({ value: 4, max: 4 })
  })

  it('fills an uncounted job once it is done', () => {
    const actor = start()
    actor.send({ type: 'FINISH', detail: 'All coins match' })
    expect(walletJobProgress(actor.getSnapshot())).toEqual({ value: 1, max: 1 })
  })
})

describe('walletJobs', () => {
  it('lists one wallet’s jobs newest first and tells subscribers', () => {
    const heard = vi.fn()
    const off = subscribeWalletJobs(heard)
    const older = beginWalletJob({ kind: 'balance-heal', identityKey: 'ID1', startedAt: 1 })
    const newer = beginWalletJob({ kind: 'item-import', identityKey: 'id1', startedAt: 2 })
    beginWalletJob({ kind: 'item-import', identityKey: 'id2', startedAt: 3 })
    expect(listWalletJobs('id1').map((j) => j.id)).toEqual([newer.id, older.id])
    expect(newer.id).toBe(`job:item-import:${(2).toString(36)}`)
    expect(walletJobIds(listWalletJobs('id1'))).toEqual(new Set([newer.id, older.id]))
    expect(heard).toHaveBeenCalledTimes(3)
    off()
  })

  it('retires a finished job quickly, a failed one after it can be read, and ignores late events', () => {
    const done = beginWalletJob({ kind: 'item-import', identityKey: 'id1', startedAt: 1 })
    const failed = beginWalletJob({ kind: 'balance-heal', identityKey: 'id1', startedAt: 2 })
    done.progress(2, 2)
    done.finish('2 imported')
    failed.fail('Chain unavailable')
    done.progress(0, 9)
    expect(listWalletJobs('id1').find((j) => j.id === done.id)).toMatchObject({ face: 'done', current: 2, total: 2 })
    expect(listWalletJobs('id1').find((j) => j.id === failed.id)).toMatchObject({ face: 'failed', error: 'Chain unavailable' })

    vi.advanceTimersByTime(2_000)
    expect(listWalletJobs('id1').map((j) => j.id)).toEqual([failed.id])
    vi.advanceTimersByTime(8_000)
    expect(listWalletJobs('id1')).toEqual([])
  })

  it('titles and counts by kind', () => {
    const job = beginWalletJob({ kind: 'item-import', identityKey: 'id1' })
    expect(walletJobCount(listWalletJobs('id1')[0]!)).toBeNull()
    job.progress(1_200, 4_000)
    const [view] = listWalletJobs('id1')
    expect(walletJobTitle(view!)).toBe('Importing collectables')
    expect(walletJobCount(view!)).toBe(`${(1_200).toLocaleString()} / ${(4_000).toLocaleString()}`)
    expect(walletJobCount({ kind: 'balance-heal', total: 8, progress: { value: 2, max: 8 } })).toBe('25%')
    expect(walletJobTitle({ kind: 'balance-heal', face: 'failed' })).toBe('Balance heal failed')
  })
})
