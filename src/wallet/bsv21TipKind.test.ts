import { describe, expect, it } from 'vitest'
import {
  chooseBsv21BatchSendPath,
  chooseBsv21SendPath,
  classifyBsv21TipKind,
  detectCosignFromLockingScript,
  normalizeCosignPubKey,
  parseBsv21Cosign,
} from './bsv21TipKind'

/** MNEE-shaped suffix: P2PKH CHECKSIGVERIFY + cosigner pubkey + CHECKSIG */
const COSIGN_PUB =
  '02' + 'ab'.repeat(32) // 33-byte compressed (test vector, not a real key)
const PLAIN_P2PKH = `76a914${'11'.repeat(20)}88ac`
const COSIGNED_SUFFIX = `76a914${'11'.repeat(20)}88ad21${COSIGN_PUB}ac`
// Minimal fake inscription prefix + cosigned lock
const COSIGNED_INSCRIBED = `006a${'00'.repeat(8)}${COSIGNED_SUFFIX}`

describe('bsv21TipKind cosign', () => {
  it('detects cosigner pubkey from locking script suffix', () => {
    const cosign = detectCosignFromLockingScript(COSIGNED_INSCRIBED)
    expect(cosign?.pubkey).toBe(COSIGN_PUB)
  })

  it('returns null for plain P2PKH', () => {
    expect(detectCosignFromLockingScript(PLAIN_P2PKH)).toBeNull()
  })

  it('classifies remittance-only cosign as cosigned', () => {
    const tip = classifyBsv21TipKind({
      cosignClaim: { pubkey: COSIGN_PUB, endpoint: 'https://example.test' },
    })
    expect(tip).toEqual({
      kind: 'cosigned',
      cosign: { pubkey: COSIGN_PUB, endpoint: 'https://example.test' },
    })
  })

  it('chooses refuse when cosigned and no cosigner client', () => {
    const tip = classifyBsv21TipKind({
      lockingScript: COSIGNED_SUFFIX,
    })
    expect(chooseBsv21SendPath(tip)).toEqual({
      path: 'refuse',
      reason: 'cosigner_required',
    })
  })

  it('chooses cosigned when a cosigner client is available', () => {
    const tip = classifyBsv21TipKind({
      lockingScript: COSIGNED_SUFFIX,
    })
    expect(tip.kind).toBe('cosigned')
    expect(chooseBsv21SendPath(tip, { cosignerAvailable: true })).toEqual({
      path: 'cosigned',
      cosign: { pubkey: COSIGN_PUB },
    })
  })

  it('plain tip sends on plain path', () => {
    expect(chooseBsv21SendPath(classifyBsv21TipKind({ lockingScript: PLAIN_P2PKH }))).toEqual({
      path: 'plain',
    })
  })

  it('treats a missing locking script as unknown, never plain', () => {
    expect(classifyBsv21TipKind({})).toEqual({ kind: 'unknown' })
    expect(chooseBsv21SendPath(classifyBsv21TipKind({}))).toEqual({
      path: 'refuse',
      reason: 'unknown_lock',
    })
  })

  it('classifies a whole input batch before sending', () => {
    const plain = classifyBsv21TipKind({ lockingScript: PLAIN_P2PKH })
    const cosigned = classifyBsv21TipKind({ lockingScript: COSIGNED_SUFFIX })
    expect(chooseBsv21BatchSendPath([plain])).toEqual({ path: 'plain' })
    expect(chooseBsv21BatchSendPath([plain, cosigned])).toEqual({
      path: 'refuse',
      reason: 'mixed_tips',
    })
    expect(chooseBsv21BatchSendPath([{ kind: 'unknown' }, plain])).toEqual({
      path: 'refuse',
      reason: 'unknown_lock',
    })
  })

  it('parses cosign JSON and normalizes pubkey', () => {
    expect(normalizeCosignPubKey(`0x${COSIGN_PUB.toUpperCase()}`)).toBe(COSIGN_PUB)
    expect(
      parseBsv21Cosign({
        pubkey: COSIGN_PUB,
        endpoint: 'cosigner.example',
        feeAddress: '1Fee...',
      }),
    ).toEqual({
      pubkey: COSIGN_PUB,
      endpoint: 'cosigner.example',
      feeAddress: '1Fee...',
    })
  })
})
