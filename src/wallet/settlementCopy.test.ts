import { describe, expect, it } from 'vitest'
import {
  classifyActivitySettlement,
  confirmationsFromHeights,
  formatSettlementLabel,
  inFlightSettlementLabel,
} from './settlementCopy'

describe('settlementCopy', () => {
  it('names a local cheque Signed before a txid exists', () => {
    expect(
      classifyActivitySettlement({ status: 'pending', hasTxid: false }),
    ).toBe('signed')
    expect(
      formatSettlementLabel({ phrase: 'signed', confirmations: null }),
    ).toBe('Signed')
  })

  it('names an accepted signed body Sent until headers cover it', () => {
    expect(
      classifyActivitySettlement({
        status: 'pending',
        hasTxid: true,
        chainProof: 'unconfirmed',
      }),
    ).toBe('sent')
    expect(
      formatSettlementLabel({ phrase: 'sent', confirmations: null }),
    ).toBe('Sent')
  })

  it('names header-proven inclusion Confirmed and can show depth', () => {
    expect(
      classifyActivitySettlement({
        status: 'complete',
        hasTxid: true,
        chainProof: 'headerProven',
      }),
    ).toBe('confirmed')
    expect(confirmationsFromHeights(100, 105)).toBe(6)
    expect(
      formatSettlementLabel({ phrase: 'confirmed', confirmations: 6 }),
    ).toBe('Confirmed · 6 blocks')
    expect(
      formatSettlementLabel({ phrase: 'confirmed', confirmations: 1 }),
    ).toBe('Confirmed · 1 block')
    expect(
      formatSettlementLabel({ phrase: 'confirmed', confirmations: null }),
    ).toBe('Confirmed')
  })

  it('does not invent confirmations when the tip is behind the mined height', () => {
    expect(confirmationsFromHeights(200, 199)).toBeNull()
    expect(confirmationsFromHeights(null, 199)).toBeNull()
  })

  it('shows honest signed/sent progress and returns confirmed rows to their timestamp', () => {
    expect(
      inFlightSettlementLabel({ status: 'complete', txid: 'ab'.repeat(32) }),
    ).toBe('Signed')
    expect(
      inFlightSettlementLabel({ status: 'pending', txid: undefined }),
    ).toBe('Signed')
    expect(
      inFlightSettlementLabel({
        status: 'pending',
        txid: 'ab'.repeat(32),
      }),
    ).toBe('Signed')
    expect(
      inFlightSettlementLabel({
        status: 'pending',
        txid: 'ab'.repeat(32),
        chainProof: 'unconfirmed',
      }),
    ).toBe('Sent')
    expect(
      inFlightSettlementLabel({
        status: 'complete',
        txid: 'ab'.repeat(32),
        chainProof: 'headerProven',
      }),
    ).toBeNull()
    expect(inFlightSettlementLabel({ status: 'failed', txid: 'ab'.repeat(32) })).toBe(
      null,
    )
  })
})
