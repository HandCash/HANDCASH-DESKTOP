/**
 * BRC-151 latched 1Sat provenance — basket `1sat-latch`, v3 remittance, O(1) verify.
 *
 * Phase 1: parse / structural verify / remittance build helpers.
 * Commit+Settle broadcast remains behind `isLatchedSendEnabled()` until script templates ship.
 */

export type ProvenanceVerifyResult = {
  proven: boolean
  reason: string | null
}

/** Companion basket for proof latch UTXOs ([BRC-151]). */
export const ONE_SAT_LATCH_BASKET = '1sat-latch' as const

export const LATCH_TAG = 'latch:1sat' as const

export const LATCH_SCHEMA_VERSION = 1 as const

export type ProvenanceV3 = {
  v: 3
  mode: 'latched'
  origin: string
  tip: string
  latch: string
  parentLatch: string
  commitTxid?: string
  settleTxid?: string
}

const OUTPOINT_RE = /^[0-9a-f]{64}([._]\d+)?$/i

export function toUnderscoreOutpoint(outpoint: string): string {
  const n = outpoint.trim()
  if (n.includes('_')) return n.toLowerCase()
  return n.replace(/\.(\d+)$/, '_$1').toLowerCase()
}

export function isValidOutpoint(outpoint: string): boolean {
  const n = toUnderscoreOutpoint(outpoint)
  if (!OUTPOINT_RE.test(n)) return false
  const [txid, vout] = n.split('_')
  return Boolean(txid && txid.length === 64 && vout != null && /^\d+$/.test(vout))
}

/** Phase 3 gate — Commit/Settle sends disabled until script template is on testnet. */
export function isLatchedSendEnabled(): boolean {
  return false
}

export function parseProvenanceV3(raw: unknown): ProvenanceV3 | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.v !== 3 || o.mode !== 'latched') return null
  if (typeof o.origin !== 'string' || typeof o.tip !== 'string') return null
  if (typeof o.latch !== 'string' || typeof o.parentLatch !== 'string') return null
  if ('beefB64' in o && o.beefB64 != null) return null
  if ('path' in o && Array.isArray(o.path)) return null

  return {
    v: 3,
    mode: 'latched',
    origin: toUnderscoreOutpoint(o.origin),
    tip: toUnderscoreOutpoint(o.tip),
    latch: toUnderscoreOutpoint(o.latch),
    parentLatch: toUnderscoreOutpoint(o.parentLatch),
    commitTxid: typeof o.commitTxid === 'string' ? o.commitTxid.trim().toLowerCase() : undefined,
    settleTxid: typeof o.settleTxid === 'string' ? o.settleTxid.trim().toLowerCase() : undefined,
  }
}

/**
 * Structural O(1) verify for v3 remittance (BRC-151).
 * On-chain latch co-spend rules are enforced when Commit/Settle sends ship.
 */
export function verifyProvenanceV3(
  provenance: unknown,
  heldOutpoint: string,
): ProvenanceVerifyResult {
  const p = parseProvenanceV3(provenance)
  if (!p) return { proven: false, reason: 'missing or non-v3 latched provenance' }

  for (const op of [p.origin, p.tip, p.latch, p.parentLatch]) {
    if (!isValidOutpoint(op)) {
      return { proven: false, reason: 'invalid outpoint in v3 provenance' }
    }
  }

  const held = toUnderscoreOutpoint(heldOutpoint)
  if (p.tip !== held) {
    return { proven: false, reason: 'tip does not match held outpoint' }
  }

  if (p.latch === p.tip || p.latch === p.parentLatch) {
    return { proven: false, reason: 'latch must differ from tip and parentLatch' }
  }

  if (p.commitTxid && p.commitTxid.length !== 64) {
    return { proven: false, reason: 'invalid commitTxid' }
  }
  if (p.settleTxid && p.settleTxid.length !== 64) {
    return { proven: false, reason: 'invalid settleTxid' }
  }

  return { proven: true, reason: null }
}

export function buildProvenanceV3(args: {
  origin: string
  tip: string
  latch: string
  parentLatch: string
  commitTxid?: string
  settleTxid?: string
}): ProvenanceV3 {
  return {
    v: 3,
    mode: 'latched',
    origin: toUnderscoreOutpoint(args.origin),
    tip: toUnderscoreOutpoint(args.tip),
    latch: toUnderscoreOutpoint(args.latch),
    parentLatch: toUnderscoreOutpoint(args.parentLatch),
    ...(args.commitTxid ? { commitTxid: args.commitTxid.trim().toLowerCase() } : {}),
    ...(args.settleTxid ? { settleTxid: args.settleTxid.trim().toLowerCase() } : {}),
  }
}

/** Tags for a latch output per BRC-151. */
export function latchOutputTags(args: {
  origin: string
  tip: string
}): string[] {
  return [
    LATCH_TAG,
    `origin:${toUnderscoreOutpoint(args.origin)}`,
    `tip:${toUnderscoreOutpoint(args.tip)}`,
  ]
}

export function isProvenanceV3(raw: unknown): boolean {
  return parseProvenanceV3(raw) != null
}
