import { describe, expect, it } from 'vitest'
import type { ActivityEntry } from './appActivity'
import type { PaymentProgress } from './paymentProgress'
import { LIVE_OUTBOUND_ID, mergeLiveOutbound } from './liveOutboundRow'

const NOW = 1_700_000_000_000
const OUTPOINT = `${'a'.repeat(64)}.0`
const OTHER = `${'b'.repeat(64)}.1`

function sending(outpoint?: string): PaymentProgress {
  return {
    phase: 'broadcasting',
    detail: 'Sending…',
    outpoint: outpoint ? outpoint.replace(/\./g, '_') : null,
  } as PaymentProgress
}

function pendingRow(partial: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: 'durable',
    origin: 'handcash',
    kind: 'spent',
    sats: 1,
    at: NOW,
    method: 'send-collectable',
    status: 'pending',
    item: { name: 'Fox', origin: OUTPOINT, outpoint: OUTPOINT },
    ...partial,
  }
}

describe('mergeLiveOutbound', () => {
  it('shows the in-flight item send before its durable row exists', () => {
    const merged = mergeLiveOutbound([], sending(OUTPOINT), NOW)

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: LIVE_OUTBOUND_ID,
      method: 'send-collectable',
      status: 'pending',
      item: { outpoint: OUTPOINT },
    })
  })

  it('stands down once the durable row for the same item lands', () => {
    const merged = mergeLiveOutbound([pendingRow()], sending(OUTPOINT), NOW)

    expect(merged.map((e) => e.id)).toEqual(['durable'])
  })

  it('is not hidden by an unrelated pending send — feeds must agree', () => {
    const unrelated = pendingRow({
      id: 'other-item',
      item: { name: 'Other', origin: OTHER, outpoint: OTHER },
    })

    const long = mergeLiveOutbound([unrelated], sending(OUTPOINT), NOW)
    const short = mergeLiveOutbound([], sending(OUTPOINT), NOW)

    expect(long[0]?.id).toBe(LIVE_OUTBOUND_ID)
    expect(short[0]?.id).toBe(LIVE_OUTBOUND_ID)
  })

  it('ignores a stranded pending row that the watchdog has not reaped yet', () => {
    const stale = pendingRow({ at: NOW - 120_000 })

    expect(mergeLiveOutbound([stale], sending(OUTPOINT), NOW)[0]?.id).toBe(
      LIVE_OUTBOUND_ID,
    )
  })

  it('matches a coin send against a pending row with no item', () => {
    const coin = pendingRow({ id: 'coin', method: 'send', item: undefined })

    expect(mergeLiveOutbound([coin], sending(), NOW).map((e) => e.id)).toEqual([
      'coin',
    ])
  })

  it('never resurrects the live row over a settled send', () => {
    const settled = pendingRow({ status: undefined, txid: 'c'.repeat(64) })
    const progress = { ...sending(OUTPOINT), phase: 'finishing' } as PaymentProgress

    expect(mergeLiveOutbound([settled], progress, NOW).map((e) => e.id)).toEqual([
      'durable',
    ])
  })

  it('drops a leftover live row when nothing is in flight', () => {
    const leftover = pendingRow({ id: LIVE_OUTBOUND_ID })
    const idle = { phase: 'idle', detail: '', outpoint: null } as PaymentProgress

    expect(mergeLiveOutbound([leftover], idle, NOW)).toEqual([])
  })
})
