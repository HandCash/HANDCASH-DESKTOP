import { describe, expect, it } from 'vitest'
import {
  parseProvenanceV2,
  provenanceFitsBudget,
  REMITTANCE_MAX_BEEF_B64_CHARS,
  verifyProvenance,
  verifyProvenanceV2,
  type ProvenanceV2,
} from './oneSatProvenance'
import { buildProvenanceV3 } from './oneSatLatch'

describe('BRC-150 remittance budget (isolated edge case)', () => {
  it('rejects oversized beefB64 instead of truncating', () => {
    const p: ProvenanceV2 = {
      v: 2,
      origin: 'aa_0',
      tip: 'bb_0',
      path: ['bb_0', 'aa_0'],
      beefB64: 'x'.repeat(REMITTANCE_MAX_BEEF_B64_CHARS + 1),
    }
    expect(provenanceFitsBudget(p)).toBe(false)
    expect(verifyProvenanceV2(p, 'bb.0').proven).toBe(false)
  })

  it('parses only v2 objects with beefB64', () => {
    expect(parseProvenanceV2({ v: 1, origin: 'a_0', tip: 'a_0', path: ['a_0'] })).toBeNull()
    expect(
      parseProvenanceV2({
        v: 2,
        origin: 'aa_0',
        tip: 'aa_0',
        path: ['aa_0'],
        beefB64: 'QQ==',
      }),
    ).toMatchObject({ v: 2, tip: 'aa_0' })
  })

  it('requires tip to match held outpoint', () => {
    const p: ProvenanceV2 = {
      v: 2,
      origin: 'aa_0',
      tip: 'bb_0',
      path: ['bb_0', 'aa_0'],
      beefB64: 'QQ==',
    }
    expect(verifyProvenanceV2(p, 'cc.0').reason).toMatch(/tip does not match/i)
  })

  it('verifyProvenance does not treat bare v3 soft-latch as authenticity', () => {
    const origin = 'aa'.repeat(32) + '_0'
    const tip = 'bb'.repeat(32) + '_1'
    const v3 = buildProvenanceV3({
      origin,
      tip,
      latch: 'cc'.repeat(32) + '_0',
      parentLatch: 'dd'.repeat(32) + '_0',
    })
    const r = verifyProvenance(v3, 'bb'.repeat(32) + '.1')
    expect(r.proven).toBe(false)
    expect(r.reason).toMatch(/not authenticity|v2|hardened/i)
  })
})
