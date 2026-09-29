import { describe, expect, it } from 'vitest'
import type { LiveAction } from '../../wallet/actionLifecycle'
import { WALLET_ACTIVITY_ORIGIN, type ActivityEntry } from '../../wallet/appActivity'
import {
  activityRowState,
  activityRowStateLabel,
  liveActionEntry,
  liveActionForEntry,
  liveActionIsFeedRow,
  liveActionTitle,
  mergeLiveActions,
} from './activityRowState'

const entry = (over: Partial<ActivityEntry>): ActivityEntry => ({
  id: 'row-1',
  origin: WALLET_ACTIVITY_ORIGIN,
  kind: 'spent',
  sats: 500,
  at: 10,
  method: 'send',
  ...over,
})

const live = (over: Partial<LiveAction>): LiveAction => ({
  id: 'action:1',
  origin: 'mint.example',
  method: 'createAction',
  description: null,
  txid: null,
  outpoints: [],
  startedAt: 5,
  face: 'approving',
  error: null,
  progress: { value: 0.5, max: 5 },
  ...over,
})

describe('activityRowState', () => {
  it('is the live phase while the action runs', () => {
    expect(
      activityRowState({ entry: entry({ status: 'pending', pendingId: 'send-1' }), live: live({ face: 'signing' }) })
    ).toBe('signing')
    expect(activityRowStateLabel('signing')).toBe('Signing')
    expect(activityRowStateLabel('settling')).toBe('Verifying')
  })

  it('reads the transaction, not the wallet, once the action has a txid', () => {
    const txid = 'cd'.repeat(32)
    // Sent and recorded: the row is done, whatever the wallet still files.
    expect(
      activityRowState({
        entry: entry({ status: 'complete', txid, pendingId: 'send-1' }),
        live: live({ face: 'broadcasting', txid }),
      })
    ).toBe('settled')
    expect(
      activityRowState({
        entry: entry({ status: 'complete', txid, pendingId: 'send-1' }),
        live: live({ face: 'settling', txid }),
      })
    ).toBe('settled')
    // Signed but the row still pending: the transaction's standing, not a phase.
    expect(
      activityRowState({
        entry: entry({ status: 'pending', txid, pendingId: 'send-1' }),
        live: live({ face: 'broadcasting', txid }),
      })
    ).toBe('unconfirmed')
    // No durable row yet: the synthesized live row is not a record. It keeps
    // the phase until the record lands instead of flashing "Unconfirmed".
    const action = live({ face: 'broadcasting', txid })
    expect(activityRowState({ entry: liveActionEntry(action), live: action })).toBe('broadcasting')
    const settling = live({ face: 'settling', txid })
    expect(activityRowState({ entry: liveActionEntry(settling), live: settling })).toBe('settling')
    // Arcade rejected it afterwards: the record's verdict paints the row.
    expect(
      activityRowState({
        entry: entry({ status: 'failed', txid, pendingId: 'send-1' }),
        live: live({ face: 'settling', txid }),
      })
    ).toBe('failed')
  })

  it('is the settlement phrase once nothing is running', () => {
    expect(activityRowState({ entry: entry({ status: 'pending' }), live: null })).toBe('signed')
    expect(
      activityRowState({ entry: entry({ status: 'pending', txid: 'ab'.repeat(32) }), live: null })
    ).toBe('unconfirmed')
    expect(
      activityRowState({
        entry: entry({ status: 'complete', txid: 'ab'.repeat(32) }),
        live: null,
        chainProof: 'headerProven',
      })
    ).toBe('confirmed')
    expect(activityRowState({ entry: entry({ status: 'complete' }), live: null })).toBe('settled')
    expect(activityRowStateLabel('settled')).toBeNull()
    expect(activityRowStateLabel('confirmed', { minedHeight: 100, tipHeight: 102 })).toBe(
      'Confirmed · 3 blocks'
    )
  })

  it('lets the durable verdict win over a retiring live action', () => {
    expect(
      activityRowState({
        entry: entry({ status: 'complete', txid: 'ab'.repeat(32) }),
        live: live({ face: 'settled', txid: 'ab'.repeat(32) }),
      })
    ).toBe('settled')
    expect(
      activityRowState({ entry: entry({ status: 'failed' }), live: live({ face: 'signing' }) })
    ).toBe('signing')
    expect(
      activityRowState({ entry: entry({ status: 'pending' }), live: live({ face: 'failed' }) })
    ).toBe('failed')
  })

  it('joins a row to its action by pendingId or txid, never by time or amount', () => {
    const actions = [
      live({ id: 'send-1', face: 'signing' }),
      live({ id: 'action:9', face: 'settling', txid: 'cd'.repeat(32) }),
    ]
    expect(liveActionForEntry(entry({ pendingId: 'send-1' }), actions)?.id).toBe('send-1')
    expect(liveActionForEntry(entry({ txid: 'CD'.repeat(32) }), actions)?.id).toBe('action:9')
    expect(liveActionForEntry(entry({ at: 5, sats: 0 }), actions)).toBeNull()
  })

  it('shows an approved, unrecorded live action as its own row, and drops it once a row claims it', () => {
    const preparing = live({ id: 'action:1', face: 'preparing', description: 'Mint Fox #1' })
    const rows = [entry({ id: 'row-a', status: 'complete', txid: 'ab'.repeat(32) })]
    const merged = mergeLiveActions(rows, [preparing])
    expect(merged.map((row) => row.id)).toEqual(['live:action:1', 'row-a'])
    expect(merged[0]?.note).toBe('Mint Fox #1')
    expect(merged[0]?.pendingId).toBe('action:1')

    const claimed = mergeLiveActions(
      [entry({ id: 'row-b', status: 'pending', pendingId: 'action:1' }), ...rows],
      [preparing]
    )
    expect(claimed.map((row) => row.id)).toEqual(['row-b', 'row-a'])

    expect(mergeLiveActions(rows, [live({ face: 'settled' })]).map((row) => row.id)).toEqual([
      'row-a',
    ])
  })

  it('does not list a request the user has not approved yet', () => {
    // The prompt is the request's whole presence; denying it leaves no row.
    const rows = [entry({ id: 'row-a', status: 'complete', txid: 'ab'.repeat(32) })]
    const approving = live({ id: 'action:1', face: 'approving', description: 'Mint Fox #1' })
    expect(mergeLiveActions(rows, [approving]).map((row) => row.id)).toEqual(['row-a'])
    expect(liveActionIsFeedRow(approving)).toBe(false)
    expect(liveActionIsFeedRow(live({ face: 'preparing' }))).toBe(true)
    expect(liveActionIsFeedRow(live({ face: 'failed' }))).toBe(true)
    // Approved: the row appears and stays through the phases.
    expect(
      mergeLiveActions(rows, [live({ id: 'action:1', face: 'signing' })]).map((row) => row.id)
    ).toEqual(['live:action:1', 'row-a'])
  })

  it('names an undescribed action by who asked and what for', () => {
    expect(liveActionTitle(live({ origin: 'plinko.lilb.it' }))).toMatch(/transaction$/)
    expect(liveActionTitle(live({ origin: WALLET_ACTIVITY_ORIGIN, method: 'payment' }))).toBe(
      'Wallet request'
    )
    expect(liveActionEntry(live({ face: 'failed', error: 'No funds' }))).toMatchObject({
      status: 'failed',
      failureReason: 'No funds',
    })
  })
})
