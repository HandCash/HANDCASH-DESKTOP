import { describe, expect, it } from 'vitest'
import {
  GENESIS_PARENT_LATCH,
  RELATIVE_LATCH,
  RELATIVE_TIP,
  buildProvenanceV3,
  buildSoftLatchProvenanceV3,
  getOneSatBrcCapabilities,
  isLatchedSendEnabled,
  isValidOutpoint,
  latchOutputTags,
  parseProvenanceV3,
  resolveLatchTipClaim,
  resolveOutpointRef,
  verifyProvenanceV3,
} from './oneSatLatch'

const ORIGIN = 'aa'.repeat(32) + '_0'
const TIP = 'bb'.repeat(32) + '_1'
const LATCH = 'cc'.repeat(32) + '_0'
const PARENT = 'dd'.repeat(32) + '_0'
const SETTLE_TX = 'ee'.repeat(32)

describe('BRC-154 latched provenance (soft-latch)', () => {
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

  it('resolves relative OUTPUT:N tip/latch against held tip txid', () => {
    const p = buildSoftLatchProvenanceV3({ origin: ORIGIN, parentLatch: PARENT })
    expect(p.tip).toBe(RELATIVE_TIP)
    expect(p.latch).toBe(RELATIVE_LATCH)
    const held = `${SETTLE_TX}.0`
    expect(verifyProvenanceV3(p, held).proven).toBe(true)
    expect(resolveOutpointRef(RELATIVE_TIP, held)).toBe(`${SETTLE_TX}_0`)
    expect(resolveOutpointRef(RELATIVE_LATCH, held)).toBe(`${SETTLE_TX}_1`)
  })

  it('requires tip to match held outpoint', () => {
    const p = buildProvenanceV3({
      origin: ORIGIN,
      tip: TIP,
      latch: LATCH,
      parentLatch: PARENT,
    })
    expect(verifyProvenanceV3(p, 'ff'.repeat(32) + '.1').reason).toMatch(/tip does not match/i)
  })

  it('latch tags include origin and tip', () => {
    expect(latchOutputTags({ origin: ORIGIN, tip: TIP })).toEqual([
      'latch:1sat',
      `origin:${ORIGIN}`,
      `tip:${TIP}`,
    ])
    expect(latchOutputTags({ origin: ORIGIN, tip: RELATIVE_TIP })).toEqual([
      'latch:1sat',
      `origin:${ORIGIN}`,
      `tip:${RELATIVE_TIP}`,
    ])
  })

  it('resolves latch tip claims for findLatch', () => {
    const latchOp = `${SETTLE_TX}.1`
    expect(resolveLatchTipClaim(latchOp, RELATIVE_TIP)).toBe(`${SETTLE_TX}_0`)
    expect(resolveLatchTipClaim(latchOp, TIP)).toBe(TIP)
  })

  it('validates outpoint shape', () => {
    expect(isValidOutpoint(TIP)).toBe(true)
    expect(isValidOutpoint(RELATIVE_TIP)).toBe(true)
    expect(isValidOutpoint('not-an-outpoint')).toBe(false)
    expect(isValidOutpoint(GENESIS_PARENT_LATCH)).toBe(true)
  })

  it('latched sends are enabled (soft-latch dust > 1 sat)', () => {
    expect(isLatchedSendEnabled()).toBe(true)
  })

  it('advertises BRC-154 capability profile with latchedSend', () => {
    expect(getOneSatBrcCapabilities()).toEqual({
      brcs: ['147', '150', '154'],
      baskets: ['1sat', '1sat-latch'],
      latchedSend: true,
      provenanceVerify: ['v2', 'v3'],
    })
  })
})
