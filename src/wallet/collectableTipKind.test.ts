import { describe, expect, it } from 'vitest'
import {
  chooseSendPath,
  classifyTipKind,
  resolveDelayedProof,
} from './collectableTipKind'

const TX = 'a'.repeat(64)
const TX2 = 'b'.repeat(64)
const PROOF = `${TX}_1`
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

  it('labels long non-P2PKH as hardenedCovenant', () => {
    expect(classifyTipKind(COVENANT).kind).toBe('hardenedCovenant')
  })

  it('returns unknown for empty script', () => {
    expect(classifyTipKind('')).toEqual({ kind: 'unknown' })
    expect(classifyTipKind(null)).toEqual({ kind: 'unknown' })
  })
})

describe('resolveDelayedProof', () => {
  it('prefers remittance over covenant link and OP_RETURN', () => {
    const remittance = `${'f'.repeat(64)}_1`
    const link = `${'e'.repeat(64)}_1`
    const state = `${'d'.repeat(64)}_1`
    expect(
      resolveDelayedProof({
        remittanceProofOutpoint: remittance,
        covenantLinkOutpoint: link,
        opReturnProofOutpoint: state,
      }),
    ).toEqual({ proofOutpoint: remittance, proofSource: 'remittance' })
  })

  it('reads proofOutpoint from hardened tip remittance JSON', () => {
    expect(
      resolveDelayedProof({
        tipCustomInstructions: JSON.stringify({
          mode: 'hardened',
          proofOutpoint: PROOF,
        }),
      }),
    ).toEqual({ proofOutpoint: PROOF, proofSource: 'remittance' })
  })

  it('falls through to covenantLink then opReturnState', () => {
    expect(
      resolveDelayedProof({
        covenantLinkOutpoint: PROOF,
        opReturnProofOutpoint: `${TX2}_1`,
      }),
    ).toEqual({ proofOutpoint: PROOF, proofSource: 'covenantLink' })

    expect(
      resolveDelayedProof({
        opReturnProofOutpoint: `${TX2}_1`,
      }),
    ).toEqual({
      proofOutpoint: `${TX2}_1`,
      proofSource: 'opReturnState',
    })
  })

  it('does not treat a basket beacon as an implicit proof source', () => {
    // Callers must not pass basket latch as remittance/link/state. Passing only
    // a beacon-shaped outpoint via a non-source field is simply ignored — there
    // is no DelayedProofSource for basket.
    const resolved = resolveDelayedProof({})
    expect(resolved.proofOutpoint).toBeNull()
    expect(resolved.proofSource).toBeNull()
    // Even if someone mistakenly puts the beacon in remittance, that is an
    // explicit remittance claim — the type still forbids a "basket" source tag.
    expect(
      resolveDelayedProof({ remittanceProofOutpoint: BEACON }).proofSource,
    ).toBe('remittance')
  })
})

describe('chooseSendPath', () => {
  it('never soft-latches a covenant tip', () => {
    const tipKind = classifyTipKind(COVENANT)
    expect(
      chooseSendPath({
        tipKind,
        recipientIdentityKey: null,
        latchOutpoint: BEACON,
        tipCustomInstructions: JSON.stringify({
          mode: 'hardened',
          proofOutpoint: PROOF,
        }),
      }).path,
    ).toBe('refuse')

    expect(
      chooseSendPath({
        tipKind,
        recipientIdentityKey: IDENTITY,
        latchOutpoint: BEACON,
        remittanceProofOutpoint: PROOF,
      }),
    ).toMatchObject({
      path: 'hardenedResend',
      proofOutpoint: PROOF,
      proofSource: 'remittance',
    })
  })

  it('refuses covenant when delayed proof is missing', () => {
    expect(
      chooseSendPath({
        tipKind: classifyTipKind(COVENANT),
        recipientIdentityKey: IDENTITY,
        latchOutpoint: BEACON,
      }).path,
    ).toBe('refuse')
  })

  it('chooses hardenedGenesis for proven soft P2PKH with identity', () => {
    expect(
      chooseSendPath({
        tipKind: classifyTipKind(P2PKH),
        provenTier: 'brc150',
        recipientIdentityKey: IDENTITY,
        latchOutpoint: BEACON,
      }),
    ).toEqual({ path: 'hardenedGenesis' })
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
