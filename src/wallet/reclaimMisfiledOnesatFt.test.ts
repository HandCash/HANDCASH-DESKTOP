import { describe, expect, it } from 'vitest'
import {
  onesatRowHasCollection,
  shouldProbeOnesatForFt,
} from './reclaimMisfiledOnesatFt'

describe('shouldProbeOnesatForFt', () => {
  it('skips collection-bound 1sats', () => {
    expect(
      shouldProbeOnesatForFt({
        tags: ['ordinal', 'collection:pixel-foxes'],
      }),
    ).toBe(false)
    expect(onesatRowHasCollection(['collection:pixel-foxes'])).toBe(true)
  })

  it('skips inscribed non-FT NFTs', () => {
    // OP_FALSE OP_IF "ord" OP_1 "text/plain" OP_0 "hi" OP_ENDIF
    const nft =
      '0063036f726451' + '0a746578742f706c61696e' + '0002' + '6869' + '68'
    expect(shouldProbeOnesatForFt({ lockingScriptHex: nft })).toBe(false)
  })

  it('probes a collection-less bare leftover', () => {
    const p2pkh = '76a914' + '11'.repeat(20) + '88ac'
    expect(
      shouldProbeOnesatForFt({
        tags: ['ordinal'],
        lockingScriptHex: p2pkh,
      }),
    ).toBe(true)
  })

  it('still probes a collection row that already says 1sat-ft', () => {
    expect(
      shouldProbeOnesatForFt({
        tags: ['collection:pixel-foxes', '1sat-ft'],
      }),
    ).toBe(true)
  })
})
