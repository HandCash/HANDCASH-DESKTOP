/**
 * A remittance may ship a path transaction as txid-only, because the receiver
 * hydrates it. The overlay's strict verifier refuses that, so a listing prefers
 * the self-contained form — but a batch-mint origin cannot fit the overlay's
 * JSON budget inlined, and the overlay hydrates a bounded number of bodies for
 * itself. These tests pin both halves against the overlay's own verifier.
 */
import {
  Beef,
  LockingScript,
  MerklePath,
  P2PKH,
  PrivateKey,
  Transaction,
  UnlockingScript,
} from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { verifyProvenanceV2 } from '../../../BRC-CLOUD/src/marketProof.js'
import { MARKET_MAX_PROVENANCE_JSON_BYTES } from './marketOverlayProtocol'
import { choosePublishableProvenance } from './marketListing'
import {
  completeProvenanceForPublish,
  fitRemittanceBeef,
  type ProvenanceV2,
} from './oneSatProvenance'

const owner = PrivateKey.fromHex('7'.padStart(64, '0'))
const ownerAddress = owner.toAddress('mainnet')

function base64(bytes: number[]): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text)
}

/** P2PKH under an `ord` envelope, which is what marks an origin. */
function ordLockingScript(): LockingScript {
  const inscription = '0063036f7264510a746578742f706c61696e0004686f6c6d68'
  return LockingScript.fromHex(new P2PKH().lock(ownerAddress).toHex() + inscription)
}

/**
 * Single-leaf path: a one-transaction block roots at the txid itself. Only the
 * origin needs one — `verifyValid` derives a later transaction from the proven
 * parent its input names, and a second path in the same block would conflict.
 */
function provenPath(txid: string): MerklePath {
  return new MerklePath(800_000, [[{ offset: 0, hash: txid, txid: true }]])
}

function lineage(): { provenance: ProvenanceV2; beef: Beef; path: string[] } {
  const origin = new Transaction()
  origin.addOutput({ satoshis: 1, lockingScript: ordLockingScript() })
  // Padding so dropping this body measurably shrinks the package.
  origin.addOutput({
    satoshis: 2,
    lockingScript: LockingScript.fromHex(`006a4c64${'ab'.repeat(100)}`),
  })

  const tip = new Transaction()
  tip.addInput({
    sourceTransaction: origin,
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript(),
  })
  tip.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(ownerAddress) })

  const beef = new Beef()
  beef.mergeTransaction(origin)
  beef.mergeTransaction(tip)
  beef.mergeBump(provenPath(origin.id('hex')))

  const path = [`${tip.id('hex')}_0`, `${origin.id('hex')}_0`]
  return {
    beef,
    path,
    provenance: {
      v: 2,
      origin: path[1]!,
      tip: path[0]!,
      path,
      beefB64: base64(beef.toBinary()),
    },
  }
}

/** Same lineage with the origin body dropped, as a lean remittance would ship. */
function slimmed(value: ReturnType<typeof lineage>): ProvenanceV2 {
  const full = value.beef.toBinary().length
  const fitted = fitRemittanceBeef(value.beef, value.path, full - 1)
  expect(fitted).not.toBeNull()
  expect(fitted!.stripped).toContain(value.path[1]!.slice(0, 64))
  return { ...value.provenance, beefB64: base64(fitted!.binary) }
}

describe('publishing a BRC-150 proof to the market overlay', () => {
  it('accepts the complete package', () => {
    expect(verifyProvenanceV2(lineage().provenance)).toMatchObject({ ok: true })
  })

  it('is what the overlay refuses once the proof is slimmed', () => {
    const value = lineage()
    expect(verifyProvenanceV2(slimmed(value))).toMatchObject({ ok: false })
  })

  it('rebuilds a slimmed proof into one the overlay accepts', async () => {
    const value = lineage()
    const published = await completeProvenanceForPublish({
      provenance: slimmed(value),
      getBeef: async () => value.beef,
    })
    expect(published).not.toBeNull()
    expect(verifyProvenanceV2(published!)).toMatchObject({ ok: true })
  })

  it('refuses when the missing body cannot be fetched', async () => {
    const value = lineage()
    const published = await completeProvenanceForPublish({
      provenance: slimmed(value),
      getBeef: async () => {
        throw new Error('offline')
      },
    })
    expect(published).toBeNull()
  })
})

/** A candidate whose canonical JSON cannot fit, standing in for a batch mint. */
function oversized(provenance: ProvenanceV2): ProvenanceV2 {
  return { ...provenance, beefB64: 'A'.repeat(MARKET_MAX_PROVENANCE_JSON_BYTES + 1) }
}

describe('choosing which proof to publish', () => {
  it('prefers the self-contained package when it fits', () => {
    const value = lineage()
    const slim = slimmed(value)
    expect(choosePublishableProvenance([value.provenance, slim])).toBe(value.provenance)
  })

  it('falls back to the slim form when the complete one is over budget', () => {
    const value = lineage()
    const slim = slimmed(value)
    expect(choosePublishableProvenance([oversized(value.provenance), slim])).toBe(slim)
  })

  it('skips a candidate that could not be assembled', () => {
    const value = lineage()
    expect(choosePublishableProvenance([null, value.provenance])).toBe(value.provenance)
  })

  it('refuses when nothing fits', () => {
    const value = lineage()
    const candidates = [oversized(value.provenance), oversized(slimmed(value))]
    expect(choosePublishableProvenance(candidates)).toBeNull()
  })
})
