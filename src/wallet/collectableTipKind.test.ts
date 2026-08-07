import { describe, expect, it } from 'vitest'
import {
  chooseSendPath,
  classifyTipKind,
  isCovenantLockedScript,
} from './collectableTipKind'

const TX2 = 'b'.repeat(64)
const BEACON = `${TX2}_1`
const P2PKH = `76a914${'ab'.repeat(20)}88ac`
const COVENANT = `01${'cd'.repeat(100)}` // non-P2PKH, long enough
const IDENTITY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

describe('classifyTipKind', () => {
  it('labels P2PKH as softP2pkh', () => {
    expect(classifyTipKind(P2PKH)).toEqual({
      kind: 'softP2pkh',
      lockingScript: P2PKH,
    })
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
