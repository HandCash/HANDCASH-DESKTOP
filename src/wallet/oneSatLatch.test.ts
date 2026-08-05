import { describe, expect, it } from 'vitest'
import {
  buildProvenanceV3,
  getOneSatBrcCapabilities,
  isLatchedSendEnabled,
  isValidOutpoint,
  latchOutputTags,
  parseProvenanceV3,
  verifyProvenanceV3,
} from './oneSatLatch'

const ORIGIN = 'aa'.repeat(32) + '_0'
const TIP = 'bb'.repeat(32) + '_1'
const LATCH = 'cc'.repeat(32) + '_0'
const PARENT = 'dd'.repeat(32) + '_0'

describe('BRC-153 latched provenance (phase 1)', () => {
  it('parseProvenanceV3 rejects v2 and hybrid objects', () => {
    expect(parseProvenanceV3({ v: 2, origin: ORIGIN, tip: TIP, path: [TIP], beefB64: 'x' })).toBeNull()
    expect(
      parseProvenanceV3({
        v: 3,
        mode: 'latched',
        origin: ORIGIN,
        tip: TIP,
        latch: LATCH,
        parentLatch: PARENT,
        beefB64: 'x',
      }),
    ).toBeNull()
  })

  it('verifyProvenanceV3 accepts valid latched remittance', () => {
    const p = buildProvenanceV3({
      origin: ORIGIN,
      tip: TIP,
      latch: LATCH,
      parentLatch: PARENT,
    })
    expect(verifyProvenanceV3(p, 'bb'.repeat(32) + '.1').proven).toBe(true)
  })

  it('requires tip to match held outpoint', () => {
    const p = buildProvenanceV3({
      origin: ORIGIN,
      tip: TIP,
      latch: LATCH,
      parentLatch: PARENT,
    })
    expect(verifyProvenanceV3(p, 'ee'.repeat(32) + '.1').reason).toMatch(/tip does not match/i)
  })

  it('latch tags include origin and tip', () => {
    expect(latchOutputTags({ origin: ORIGIN, tip: TIP })).toEqual([
      'latch:1sat',
      `origin:${ORIGIN}`,
      `tip:${TIP}`,
    ])
  })

  it('validates outpoint shape', () => {
    expect(isValidOutpoint(TIP)).toBe(true)
    expect(isValidOutpoint('not-an-outpoint')).toBe(false)
  })

  it('latched sends disabled until script template ships', () => {
    expect(isLatchedSendEnabled()).toBe(false)
  })

  it('advertises BRC-153 capability profile', () => {
    expect(getOneSatBrcCapabilities()).toEqual({
      brcs: ['147', '150', '153'],
      baskets: ['1sat', '1sat-latch'],
      latchedSend: false,
      provenanceVerify: ['v2', 'v3'],
    })
  })
})
