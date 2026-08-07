import { describe, expect, it } from 'vitest'
import {
  chooseSendPath,
  classifyTipKind,
  hasSpendableP2pkhBranch,
  isCovenantLockedScript,
  normalizeLockingScriptHex,
} from './collectableTipKind'

const TX2 = 'b'.repeat(64)
const BEACON = `${TX2}_1`
const P2PKH = `76a914${'ab'.repeat(20)}88ac`
const COVENANT = `01${'cd'.repeat(100)}` // non-P2PKH, long enough
const ORD_PREFIX =
  '0063036f7264010118746578742f706c61696e3b636861727365743d7574662d380003666f6f68'
const INSCRIBED = `${ORD_PREFIX}${P2PKH}`
const IDENTITY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

describe('normalizeLockingScriptHex', () => {
  it('strips 0x and leaves bare hex', () => {
    expect(normalizeLockingScriptHex(`0x${P2PKH}`)).toBe(P2PKH)
    expect(normalizeLockingScriptHex(P2PKH)).toBe(P2PKH)
  })

  it('calls toHex on script objects', () => {
    expect(normalizeLockingScriptHex({ toHex: () => `0x${P2PKH}` })).toBe(P2PKH)
  })
})

describe('classifyTipKind', () => {
  it('labels P2PKH as softP2pkh', () => {
    expect(classifyTipKind(P2PKH)).toEqual({
      kind: 'softP2pkh',
      lockingScript: P2PKH,
    })
  })

  it('labels 0x-prefixed P2PKH as softP2pkh', () => {
    expect(classifyTipKind(`0x${P2PKH}`).kind).toBe('softP2pkh')
  })

  it('labels inscribed (ord + P2PKH) tips as softP2pkh', () => {
    expect(hasSpendableP2pkhBranch(INSCRIBED)).toBe(true)
    expect(classifyTipKind(INSCRIBED)).toEqual({
      kind: 'softP2pkh',
      lockingScript: INSCRIBED,
    })
    expect(isCovenantLockedScript(INSCRIBED)).toBe(false)
  })

  it('labels long non-P2PKH as covenantLocked', () => {
    expect(classifyTipKind(COVENANT).kind).toBe('covenantLocked')
    expect(isCovenantLockedScript(COVENANT)).toBe(true)
    expect(isCovenantLockedScript(P2PKH)).toBe(false)
  })

  it('returns unknown for empty script', () => {
    expect(classifyTipKind('')).toEqual({ kind: 'unknown' })
    expect(classifyTipKind(null)).toEqual({ kind: 'unknown' })
  })
})

describe('chooseSendPath', () => {
  it('refuses covenant tips (must abandon)', () => {
    const tipKind = classifyTipKind(COVENANT)
    expect(
      chooseSendPath({
        tipKind,
        recipientIdentityKey: null,
        latchOutpoint: BEACON,
      }),
    ).toMatchObject({
      path: 'refuse',
      reason: expect.stringMatching(/abandon/i),
    })

    expect(
      chooseSendPath({
        tipKind,
        recipientIdentityKey: IDENTITY,
        latchOutpoint: BEACON,
      }).path,
    ).toBe('refuse')
  })

  it('soft-latches proven soft P2PKH regardless of identity', () => {
    expect(
      chooseSendPath({
        tipKind: classifyTipKind(P2PKH),
        provenTier: 'brc150',
        recipientIdentityKey: IDENTITY,
        latchOutpoint: BEACON,
      }),
    ).toEqual({ path: 'softLatch', latchOutpoint: toUnderscore(BEACON) })
  })

  it('soft-latches inscribed soft tips', () => {
    expect(
      chooseSendPath({
        tipKind: classifyTipKind(INSCRIBED),
        latchOutpoint: BEACON,
      }),
    ).toEqual({ path: 'softLatch', latchOutpoint: toUnderscore(BEACON) })
  })

  it('soft-latches unproven soft P2PKH (or missing identity)', () => {
    expect(
      chooseSendPath({
        tipKind: classifyTipKind(P2PKH),
        provenTier: 'unproven',
        recipientIdentityKey: IDENTITY,
        latchOutpoint: BEACON,
      }),
    ).toEqual({ path: 'softLatch', latchOutpoint: toUnderscore(BEACON) })

    expect(
      chooseSendPath({
        tipKind: classifyTipKind(P2PKH),
        provenTier: 'brc150',
        recipientIdentityKey: null,
        latchOutpoint: null,
      }),
    ).toEqual({ path: 'softLatch', latchOutpoint: null })
  })

  it('refuses unknown tip kinds', () => {
    expect(
      chooseSendPath({
        tipKind: { kind: 'unknown' },
        recipientIdentityKey: IDENTITY,
      }),
    ).toMatchObject({ path: 'refuse' })
  })
})

function toUnderscore(op: string): string {
  return op.replace(/\.(\d+)$/, '_$1')
}
