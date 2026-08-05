import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REPAIR_THROTTLE_MS,
  describeReqNote,
  diagnoseFailedActions,
  repairFailedActions,
  resetFailedActionRepairForTests,
} from './failedActions'
import type { ActiveWallet } from './session'

beforeEach(() => {
  resetFailedActionRepairForTests()
})

type Req = {
  txid: string
  status?: string
  wasBroadcast?: boolean
  history?: string
}

function history(...notes: Array<Record<string, unknown>>): string {
  return JSON.stringify({ notes })
}

function makeActive(args: {
  actions?: Array<{ txid?: string; status?: string; satoshis?: number }>
  totalActions?: number
  reqs?: Req[]
  reqsAfterUnfail?: Req[]
  monitor?: boolean
  reviewThrows?: boolean
}): {
  active: ActiveWallet
  listFailedActions: ReturnType<typeof vi.fn>
  runTask: ReturnType<typeof vi.fn>
  reviewStatus: ReturnType<typeof vi.fn>
} {
  const actions = args.actions ?? []
  let unfailed = false

  const listFailedActions = vi.fn(async (_a: unknown, unfail?: boolean) => {
    if (unfail) unfailed = true
    return { totalActions: args.totalActions ?? actions.length, actions }
  })

  const findProvenTxReqs = vi.fn(async () =>
    unfailed && args.reqsAfterUnfail ? args.reqsAfterUnfail : (args.reqs ?? []),
  )

  const reviewStatus = vi.fn(async () => {
    if (args.reviewThrows) throw new Error('repair unavailable')
    return { log: 'ok' }
  })

  const runTask = vi.fn(async () => 'ran')

  const active = {
    wallet: {
      listFailedActions,
      storage: {
        findProvenTxReqs,
        runAsStorageProvider: async <R>(run: (sp: unknown) => Promise<R>) => run({ reviewStatus }),
      },
    },
    monitor: args.monitor === false ? undefined : { runTask },
  } as unknown as ActiveWallet

  return { active, listFailedActions, runTask, reviewStatus }
}

describe('describeReqNote', () => {
  it('keeps only the fields that carry signal', () => {
    const note = describeReqNote({
      when: '2026-08-05T00:00:00.000Z',
      what: 'validateReqFailed',
      noRawTx: true,
      noTxIds: false,
      noInputBEEF: true,
      txid: 'a'.repeat(64),
    })
    expect(note).toBe('validateReqFailed (noRawTx=true noInputBEEF=true)')
  })

  it('names a note that carries nothing but its label', () => {
    expect(describeReqNote({ what: 'confirmDoubleSpend' })).toBe('confirmDoubleSpend')
    expect(describeReqNote({})).toBe('unknown')
  })

  it('caps an unbounded field', () => {
    const note = describeReqNote({ what: 'postBeefError', message: 'x'.repeat(500) })
    expect(note.length).toBeLessThan(120)
  })
})

describe('diagnoseFailedActions', () => {
  it('says nothing when the wallet holds no failed actions', async () => {
    const { active } = makeActive({ actions: [] })
    await expect(diagnoseFailedActions(active)).resolves.toBeNull()
  })

  it('reports the count, stranded sats and why each req failed', async () => {
    const { active } = makeActive({
      actions: [
        { txid: 'AA', status: 'failed', satoshis: 3915382 },
        { txid: 'bb', status: 'failed', satoshis: -100 },
      ],
      reqs: [
        {
          txid: 'aa',
          status: 'invalid',
          wasBroadcast: false,
          history: history({ what: 'validateReqFailed', noInputBEEF: true }),
        },
        {
          txid: 'bb',
          status: 'doubleSpend',
          wasBroadcast: true,
          history: history({ what: 'confirmDoubleSpend' }),
        },
      ],
    })

    const report = await diagnoseFailedActions(active)
    expect(report).toEqual({
      count: 2,
      satoshis: 3915482,
      neverBroadcast: 1,
      doubleSpend: 1,
      causes: ['validateReqFailed (noInputBEEF=true)', 'confirmDoubleSpend'],
    })
  })

  it('takes the newest note as the cause', async () => {
    const { active } = makeActive({
      actions: [{ txid: 'aa' }],
      reqs: [
        {
          txid: 'aa',
          status: 'invalid',
          history: history({ what: 'first' }, { what: 'last' }),
        },
      ],
    })
    const report = await diagnoseFailedActions(active)
    expect(report?.causes).toEqual(['last'])
  })

  it('still reports the count when history is unparseable', async () => {
    const { active } = makeActive({
      actions: [{ txid: 'aa' }],
      reqs: [{ txid: 'aa', status: 'invalid', history: 'not json' }],
    })
    const report = await diagnoseFailedActions(active)
    expect(report?.count).toBe(1)
    expect(report?.causes).toEqual([])
  })

  it('trusts totalActions over the returned page', async () => {
    const { active } = makeActive({ actions: [{ txid: 'aa' }], totalActions: 59 })
    const report = await diagnoseFailedActions(active)
    expect(report?.count).toBe(59)
  })

  it('does not look up reqs for actions that never got a txid', async () => {
    const { active } = makeActive({ actions: [{ txid: '', satoshis: 808037 }] })
    const report = await diagnoseFailedActions(active)
    expect(report?.count).toBe(1)
    expect(report?.neverBroadcast).toBe(0)
  })
})

describe('repairFailedActions', () => {
  it('queues nothing when there is nothing failed', async () => {
    const { active, runTask } = makeActive({ actions: [] })
    await expect(repairFailedActions(active)).resolves.toEqual({
      queued: 0,
      rescued: 0,
      repaired: false,
    })
    expect(runTask).not.toHaveBeenCalled()
  })

  it('unfails, runs the recovery task, then repairs stranded inputs', async () => {
    const { active, listFailedActions, runTask, reviewStatus } = makeActive({
      actions: [{ txid: 'aa' }],
      reqs: [{ txid: 'aa', status: 'invalid' }],
      reqsAfterUnfail: [{ txid: 'aa', status: 'invalid' }],
    })

    const result = await repairFailedActions(active)

    expect(listFailedActions).toHaveBeenCalledWith(expect.anything(), true)
    expect(runTask).toHaveBeenCalledWith('UnFail')
    expect(reviewStatus).toHaveBeenCalled()
    expect(result).toEqual({ queued: 1, rescued: 0, repaired: true })
  })

  it('counts a req that left terminal status as rescued', async () => {
    const { active } = makeActive({
      actions: [{ txid: 'aa' }, { txid: 'bb' }],
      reqs: [
        { txid: 'aa', status: 'invalid' },
        { txid: 'bb', status: 'invalid' },
      ],
      reqsAfterUnfail: [
        { txid: 'aa', status: 'unmined' },
        { txid: 'bb', status: 'invalid' },
      ],
    })
    const result = await repairFailedActions(active)
    expect(result.rescued).toBe(1)
  })

  it('does not count a req still queued for recovery as rescued', async () => {
    const { active } = makeActive({
      actions: [{ txid: 'aa' }],
      reqs: [{ txid: 'aa', status: 'invalid' }],
      reqsAfterUnfail: [{ txid: 'aa', status: 'unfail' }],
    })
    const result = await repairFailedActions(active)
    expect(result.rescued).toBe(0)
  })

  it('reports repair as incomplete when the toolbox cannot run it', async () => {
    const { active } = makeActive({
      actions: [{ txid: 'aa' }],
      reqs: [{ txid: 'aa', status: 'invalid' }],
      reviewThrows: true,
    })
    const result = await repairFailedActions(active)
    expect(result).toEqual({ queued: 1, rescued: 0, repaired: false })
  })

  it('paces a backlog of rejected transactions instead of stalling every Refresh', async () => {
    const { active, runTask } = makeActive({
      actions: [{ txid: 'aa' }],
      reqs: [{ txid: 'aa', status: 'invalid' }],
    })

    await repairFailedActions(active, { now: 1_000 })
    expect(runTask).toHaveBeenCalledTimes(1)

    const soon = await repairFailedActions(active, { now: 1_000 + REPAIR_THROTTLE_MS - 1 })
    expect(soon.throttled).toBe(true)
    expect(runTask).toHaveBeenCalledTimes(1)

    await repairFailedActions(active, { now: 1_000 + REPAIR_THROTTLE_MS })
    expect(runTask).toHaveBeenCalledTimes(2)
  })

  it('runs anyway when forced', async () => {
    const { active, runTask } = makeActive({
      actions: [{ txid: 'aa' }],
      reqs: [{ txid: 'aa', status: 'invalid' }],
    })
    await repairFailedActions(active, { now: 1_000 })
    const forced = await repairFailedActions(active, { now: 1_100, force: true })
    expect(forced.throttled).toBeUndefined()
    expect(runTask).toHaveBeenCalledTimes(2)
  })

  it('still repairs when no monitor is available to run the task', async () => {
    const { active, reviewStatus } = makeActive({
      actions: [{ txid: 'aa' }],
      reqs: [{ txid: 'aa', status: 'invalid' }],
      monitor: false,
    })
    const result = await repairFailedActions(active)
    expect(reviewStatus).toHaveBeenCalled()
    expect(result.repaired).toBe(true)
  })
})
