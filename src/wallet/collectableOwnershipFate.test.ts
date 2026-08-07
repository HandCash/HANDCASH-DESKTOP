import { describe, expect, it } from 'vitest'
import { ownershipFate } from './collectableOwnershipFate'
import { classifyTipKind } from './collectableTipKind'

const P2PKH = `76a914${'ab'.repeat(20)}88ac`
const COVENANT = `01${'cd'.repeat(100)}`

describe('ownershipFate', () => {
  it('keeps tips present in the live address set', () => {
    expect(
      ownershipFate({
        tipKind: classifyTipKind(P2PKH),
        inLiveSet: true,
        unjudged: false,
      }),
    ).toBe('keepLive')
  })

  it('holds missing tips inside settle grace', () => {
    expect(
      ownershipFate({
        tipKind: classifyTipKind(P2PKH),
        inLiveSet: false,
        unjudged: true,
      }),
    ).toBe('graceHold')
  })

  it('keeps covenant tips missing from the address scan past grace', () => {
    expect(
      ownershipFate({
        tipKind: classifyTipKind(COVENANT),
        inLiveSet: false,
        unjudged: false,
      }),
    ).toBe('keepCovenant')
  })

  it('keeps brc156-proven tips even when tipKind is softP2pkh', () => {
    expect(
      ownershipFate({
        tipKind: classifyTipKind(P2PKH),
        inLiveSet: false,
        unjudged: false,
        provenTier: 'brc156',
      }),
    ).toBe('keepCovenant')
  })

  it('ghost-drops soft P2PKH past grace when missing from live', () => {
    expect(
      ownershipFate({
        tipKind: classifyTipKind(P2PKH),
        inLiveSet: false,
        unjudged: false,
        provenTier: 'brc150',
      }),
    ).toBe('ghostDrop')
  })

  it('never ghost-drops hardenedCovenant (exhaustive)', () => {
    const fate = ownershipFate({
      tipKind: classifyTipKind(COVENANT),
      inLiveSet: false,
      unjudged: false,
      provenTier: 'unproven',
    })
    expect(fate).not.toBe('ghostDrop')
    expect(fate).toBe('keepCovenant')
  })
})
