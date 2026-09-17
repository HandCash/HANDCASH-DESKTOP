import { describe, expect, it } from 'vitest'
import {
  ancestryRideForSpend,
  isHeaderFinal,
  maySelectAsInput,
  proofKindFromBeefGap,
  type ChainProofKind,
} from './chainProofKind'

describe('chainProofKind', () => {
  const mined: ChainProofKind = { kind: 'headerProven', height: 900_001 }
  const chained: ChainProofKind = {
    kind: 'unconfirmed',
    ancestry: 'bodies-complete',
  }
  const stub: ChainProofKind = {
    kind: 'unconfirmed',
    ancestry: 'bodies-missing',
  }

  it('lets header-proven and complete-body unconfirmed coins fund a child', () => {
    expect(maySelectAsInput(mined)).toBe(true)
    expect(maySelectAsInput(chained)).toBe(true)
    expect(maySelectAsInput(stub)).toBe(false)
    expect(maySelectAsInput({ kind: 'unknown' })).toBe(false)
  })

  it('rides merkle against headers for mined coins, bodies for unconfirmed', () => {
    expect(ancestryRideForSpend(mined)).toEqual({
      ride: 'merkle-to-header',
      height: 900_001,
    })
    expect(ancestryRideForSpend(chained)).toEqual({ ride: 'unconfirmed-bodies' })
    expect(ancestryRideForSpend(stub)).toEqual({
      ride: 'refuse',
      reason: 'missing-bodies',
    })
    expect(ancestryRideForSpend({ kind: 'unknown' })).toEqual({
      ride: 'refuse',
      reason: 'unknown-proof',
    })
  })

  it('does not treat Arcade/indexer presence as header finality', () => {
    expect(isHeaderFinal(mined)).toBe(true)
    expect(isHeaderFinal(chained)).toBe(false)
  })

  it('maps a BEEF with parent merkle as chainable unconfirmed, not missing', () => {
    expect(proofKindFromBeefGap('none')).toEqual({
      kind: 'unconfirmed',
      ancestry: 'bodies-complete',
    })
    expect(proofKindFromBeefGap('unconfirmed-parents')).toEqual({
      kind: 'unconfirmed',
      ancestry: 'bodies-complete',
    })
    expect(proofKindFromBeefGap('missing-bodies')).toEqual({
      kind: 'unconfirmed',
      ancestry: 'bodies-missing',
    })
  })
})
