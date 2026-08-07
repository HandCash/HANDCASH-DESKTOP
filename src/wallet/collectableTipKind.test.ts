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

  it('derives proof from remittance commitTxid when proofOutpoint is absent', () => {
    const commit = 'f'.repeat(64)
    expect(
      resolveDelayedProof({
        tipCustomInstructions: JSON.stringify({
          mode: 'hardened',
          commitTxid: commit,
        }),
      }),
    ).toEqual({
      proofOutpoint: `${commit}_1`,
      proofSource: 'remittance',
    })
  })

  it('uses OP_RETURN / commit-derived hints when remittance is empty', () => {
    const commit = 'c'.repeat(64)
    expect(
      resolveDelayedProof({
        opReturnProofOutpoint: `${commit}_1`,
      }),
    ).toEqual({
      proofOutpoint: `${commit}_1`,
      proofSource: 'opReturnState',
    })
    expect(
      resolveDelayedProof({
        commitDerivedProofOutpoint: `${commit}_1`,
      }),
    ).toEqual({
      proofOutpoint: `${commit}_1`,
      proofSource: 'opReturnState',
    })
  })

  it('does not treat a basket beacon as an implicit proof source', () => {
    const resolved = resolveDelayedProof({})
    expect(resolved.proofOutpoint).toBeNull()
    expect(resolved.proofSource).toBeNull()
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
        hardenedSendEnabled: true,
      }).path,
    ).toBe('refuse')

    expect(
      chooseSendPath({
        tipKind,
        recipientIdentityKey: IDENTITY,
        latchOutpoint: BEACON,
        remittanceProofOutpoint: PROOF,
        hardenedSendEnabled: true,
      }),
    ).toMatchObject({
      path: 'hardenedResend',
      proofOutpoint: PROOF,
      proofSource: 'remittance',
    })
  })

  it('still resends covenant tips when hardened genesis is disabled', () => {
    expect(
      chooseSendPath({
        tipKind: classifyTipKind(COVENANT),
        recipientIdentityKey: IDENTITY,
        remittanceProofOutpoint: PROOF,
        hardenedSendEnabled: false,
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
        hardenedSendEnabled: true,
      }).path,
    ).toBe('refuse')
  })

  it('chooses hardenedGenesis for proven soft P2PKH with identity when enabled', () => {
    expect(
      chooseSendPath({
        tipKind: classifyTipKind(P2PKH),
        provenTier: 'brc150',
        recipientIdentityKey: IDENTITY,
        latchOutpoint: BEACON,
        hardenedSendEnabled: true,
      }),
    ).toEqual({ path: 'hardenedGenesis' })
  })

  it('soft-latches proven soft P2PKH when hardened send is disabled', () => {
    expect(
      chooseSendPath({
        tipKind: classifyTipKind(P2PKH),
        provenTier: 'brc150',
        recipientIdentityKey: IDENTITY,
        latchOutpoint: BEACON,
        hardenedSendEnabled: false,
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
        hardenedSendEnabled: true,
      }),
    ).toEqual({ path: 'softLatch', latchOutpoint: toUnderscore(BEACON) })

    expect(
      chooseSendPath({
        tipKind: classifyTipKind(P2PKH),
        provenTier: 'brc150',
        recipientIdentityKey: null,
        latchOutpoint: null,
        hardenedSendEnabled: true,
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
