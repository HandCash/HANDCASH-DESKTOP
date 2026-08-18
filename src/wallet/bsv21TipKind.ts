/**
 * Explicit tip / send-path vocabulary for BSV-21 fungibles (BRC-163).
 *
 * Cosigner-gated tips (e.g. MNEE) MUST NOT fall through to plain createAction.
 * Cosign is optional — plain owner-only tips use path `plain`.
 */
import { normalizeLockingScriptHex } from './collectableTipKind'

/** Compressed secp256k1 pubkey hex (33 bytes). */
const COSIGN_PUBKEY_RE = /^[0-9a-f]{66}$/i

/**
 * Owner P2PKH with CHECKSIGVERIFY + cosigner push + CHECKSIG (MNEE-shaped).
 * Matched at the end of the locking script (after any inscription prefix).
 */
const COSIGNED_P2PKH_SUFFIX =
  /76a914[0-9a-f]{40}88ad21([0-9a-f]{66})ac$/i

export type Bsv21Cosign = {
  /** Compressed cosigner pubkey (33-byte hex). */
  pubkey: string
  /** Optional issuer transfer API base (host or https URL). */
  endpoint?: string
  /** Optional cosigner fee address. */
  feeAddress?: string
}

export type Bsv21TipKind =
  | { kind: 'plain' }
  | { kind: 'cosigned'; cosign: Bsv21Cosign }
  | { kind: 'unknown' }

export type Bsv21SendPath =
  | { path: 'plain' }
  | { path: 'cosigned'; cosign: Bsv21Cosign }
  | { path: 'refuse'; reason: string }

export function normalizeCosignPubKey(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== 'string') return null
  const hex = raw.trim().toLowerCase().replace(/^0x/, '')
  return COSIGN_PUBKEY_RE.test(hex) ? hex : null
}

export function parseBsv21Cosign(raw: unknown): Bsv21Cosign | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const pubkey = normalizeCosignPubKey(
    typeof o.pubkey === 'string'
      ? o.pubkey
      : typeof o.pubKey === 'string'
        ? o.pubKey
        : null,
  )
  if (!pubkey) return null
  const endpoint =
    typeof o.endpoint === 'string' && o.endpoint.trim()
      ? o.endpoint.trim().slice(0, 256)
      : undefined
  const feeAddress =
    typeof o.feeAddress === 'string' && o.feeAddress.trim()
      ? o.feeAddress.trim().slice(0, 128)
      : undefined
  return {
    pubkey,
    ...(endpoint ? { endpoint } : {}),
    ...(feeAddress ? { feeAddress } : {}),
  }
}

/**
 * Detect MNEE-shaped (and compatible) cosigner locks from locking-script hex.
 */
export function detectCosignFromLockingScript(
  lockingScript: unknown,
): Bsv21Cosign | null {
  const hex = normalizeLockingScriptHex(lockingScript)
  if (!hex) return null
  const m = hex.match(COSIGNED_P2PKH_SUFFIX)
  if (!m?.[1]) return null
  const pubkey = normalizeCosignPubKey(m[1])
  return pubkey ? { pubkey } : null
}

/**
 * Classify a held tip from script and/or remittance claims.
 * Script wins when it clearly shows a cosign suffix; else remittance cosign;
 * else plain when we have a normal P2PKH checksig ending; else unknown.
 */
export function classifyBsv21TipKind(args: {
  lockingScript?: unknown
  cosignClaim?: Bsv21Cosign | null
}): Bsv21TipKind {
  const fromScript = detectCosignFromLockingScript(args.lockingScript)
  if (fromScript) return { kind: 'cosigned', cosign: mergeCosign(fromScript, args.cosignClaim) }

  if (args.cosignClaim?.pubkey) {
    return { kind: 'cosigned', cosign: args.cosignClaim }
  }

  const hex = normalizeLockingScriptHex(args.lockingScript)
  if (!hex) return { kind: 'unknown' }

  // Bare / inscribed P2PKH ending in CHECKSIG (not CHECKSIGVERIFY+cosign).
  if (/76a914[0-9a-f]{40}88ac$/i.test(hex)) return { kind: 'plain' }

  return { kind: 'unknown' }
}

/**
 * Classify every input in one fungible send before the parent chart starts.
 * A batch cannot partially fall through: mixed plain/cosigned tips refuse as a
 * named path, and any unknown lock fails closed.
 */
export function chooseBsv21BatchSendPath(
  tips: Bsv21TipKind[],
): Bsv21SendPath {
  if (tips.length === 0) return { path: 'refuse', reason: 'no_tips' }
  if (tips.some((tip) => tip.kind === 'unknown')) {
    return { path: 'refuse', reason: 'unknown_lock' }
  }
  const plain = tips.some((tip) => tip.kind === 'plain')
  const cosigned = tips.some((tip) => tip.kind === 'cosigned')
  if (plain && cosigned) return { path: 'refuse', reason: 'mixed_tips' }
  if (cosigned) return { path: 'refuse', reason: 'cosigner_required' }
  return { path: 'plain' }
}

function mergeCosign(base: Bsv21Cosign, claim?: Bsv21Cosign | null): Bsv21Cosign {
  if (!claim) return base
  return {
    pubkey: base.pubkey,
    ...(claim.endpoint || base.endpoint
      ? { endpoint: claim.endpoint ?? base.endpoint }
      : {}),
    ...(claim.feeAddress || base.feeAddress
      ? { feeAddress: claim.feeAddress ?? base.feeAddress }
      : {}),
  }
}

/**
 * Choose the only legal send path for a tip kind.
 * Cosigned tips refuse unless a cosigner client is available for that pubkey.
 */
export function chooseBsv21SendPath(
  tip: Bsv21TipKind,
  opts?: { cosignerAvailable?: boolean },
): Bsv21SendPath {
  switch (tip.kind) {
    case 'plain':
      return { path: 'plain' }
    case 'cosigned':
      if (opts?.cosignerAvailable) {
        return { path: 'cosigned', cosign: tip.cosign }
      }
      return { path: 'refuse', reason: 'cosigner_required' }
    case 'unknown':
      return { path: 'refuse', reason: 'unknown_lock' }
    default: {
      const _exhaustive: never = tip
      return _exhaustive
    }
  }
}
