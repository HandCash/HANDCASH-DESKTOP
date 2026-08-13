/**
 * Single authenticity policy for every collectable receive.
 *
 * Order is protocol, not preference:
 *   1. BRC-150 complete tip→origin BEEF verification (the only proof)
 *   2. indexer/chain discovery for UX only (never proven)
 */
import { verifyProvenanceV2 } from './oneSatProvenance'
import { Hash, Transaction, Utils } from '@bsv/sdk'
import { getActiveWallet } from './session'
import { hasOrdEnvelope } from './ordinalOwnership'
import {
  getOriginCommitment,
  rememberOriginCommitment,
  type AuthenticityTier,
  type ProvenVerdict,
} from './provenCache'
import type { Chain } from './vault'

/** Immutable SHA-256 commitment to the origin locking script. */
export function originScriptHash(scriptHex: string): string {
  const normalized = scriptHex.trim()
  if (!normalized || normalized.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(normalized)) {
    throw new Error('Invalid origin locking script')
  }
  return Utils.toHex(Hash.sha256(Utils.toArray(normalized, 'hex')))
}

export function isValidOriginScriptHash(hash: string): boolean {
  return /^[0-9a-f]{64}$/i.test(hash.trim())
}

export type OriginCommitmentResult = {
  proven: boolean
  reason: string | null
  originScriptHash?: string
}

export type AuthenticityResult = {
  tier: AuthenticityTier
  proven: boolean
  reason: string | null
  originScriptHash?: string
}

/**
 * Verify and pin the one-time origin envelope commitment.
 * Later transfers reuse the immutable local pin; they do not replay ownership.
 */
export async function verifyOriginScriptCommitment(args: {
  origin: string
  expectedScriptHash: string
  chain: Chain
  /** Already BEEF-verified origin, used by the genesis bootstrap and tests. */
  verifiedOriginTransaction?: Transaction
}): Promise<OriginCommitmentResult> {
  const expected = args.expectedScriptHash.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    return { proven: false, reason: 'invalid originScriptHash' }
  }
  const pinned = getOriginCommitment(args.origin)
  if (pinned) {
    return pinned === expected
      ? { proven: true, reason: null, originScriptHash: expected }
      : { proven: false, reason: 'origin script commitment changed' }
  }

  const match = /^([0-9a-f]{64})[_.](\d+)$/i.exec(args.origin.trim())
  if (!match) return { proven: false, reason: 'invalid origin outpoint' }

  let scriptHex: string | undefined
  let satoshis: number | undefined
  try {
    let originTx = args.verifiedOriginTransaction
    if (!originTx) {
      const wallet = getActiveWallet()
      if (!wallet?.services?.getBeefForTxid) {
        return { proven: false, reason: 'origin BEEF unavailable' }
      }
      const beef = await wallet.services.getBeefForTxid(match[1]!)
      const tracker = await wallet.services.getChainTracker()
      if (!(await beef.verify(tracker, false))) {
        return { proven: false, reason: 'origin BEEF invalid' }
      }
      originTx = beef.findAtomicTransaction(match[1]!)
    }
    if (!originTx || originTx.id('hex').toLowerCase() !== match[1]!.toLowerCase()) {
      return { proven: false, reason: 'origin transaction mismatch' }
    }
    const output = originTx.outputs[Number(match[2])]
    scriptHex = output?.lockingScript?.toHex()
    satoshis = output?.satoshis
  } catch {
    return { proven: false, reason: 'origin transaction malformed' }
  }
  if (satoshis !== 1) return { proven: false, reason: 'origin is not one satoshi' }
  if (!hasOrdEnvelope(scriptHex)) {
    return { proven: false, reason: 'origin has no valid ord envelope' }
  }
  if (!scriptHex || originScriptHash(scriptHex) !== expected) {
    return { proven: false, reason: 'originScriptHash mismatch' }
  }

  try {
    rememberOriginCommitment(args.origin, expected)
  } catch (err) {
    return {
      proven: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
  return { proven: true, reason: null, originScriptHash: expected }
}

export function verifyAuthenticityLadder(args: {
  heldOutpoint: string
  /** BRC-150 v2 remittance, when available. */
  provenance?: unknown
  /** True only when identity was recovered through the final discovery fallback. */
  indexerResolved?: boolean
}): AuthenticityResult {
  if (args.provenance != null) {
    const v2 = verifyProvenanceV2(args.provenance, args.heldOutpoint)
    if (v2.proven) {
      return { tier: 'brc150', proven: true, reason: null }
    }
  }

  return {
    tier: 'unproven',
    proven: false,
    reason: args.indexerResolved
      ? 'Identity resolved by indexer; no BRC-150 authenticity proof'
      : 'No valid BRC-150 authenticity proof',
  }
}

export function authenticityResultToVerdict(result: AuthenticityResult): ProvenVerdict {
  return {
    tier: result.tier,
    originScriptHash: result.originScriptHash,
    verifiedAt: Date.now(),
  }
}
