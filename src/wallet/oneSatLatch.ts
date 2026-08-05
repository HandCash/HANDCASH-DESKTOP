/**
 * BRC-153 latched 1Sat provenance — basket `1sat-latch`, v3 remittance, O(1) verify.
 *
 * Soft-latch (live): tip + latch are P2PKH outputs co-created in one settle-style
 * transfer. Remittance tip/latch may use relative `OUTPUT:N` refs resolved against
 * the held tip's txid (so remittance can be built before the settle txid is known).
 * Full BOLT covenant Commit/Settle remains a future hardening path.
 */

export type ProvenanceVerifyResult = {
  proven: boolean
  reason: string | null
}

/** Companion basket for proof latch UTXOs ([BRC-153]). */
export const ONE_SAT_LATCH_BASKET = '1sat-latch' as const

export const LATCH_TAG = 'latch:1sat' as const

export const LATCH_SCHEMA_VERSION = 1 as const

/**
 * Soft-latch P2PKH latch value ([BRC-153]).
 * Exactly **2 satoshis** — never 1 (that is a tip) — so address scanners still
 * find a plain P2PKH latch while receivers can classify it without a script marker.
 */
export const LATCH_DUST_SATS = 2 as const

/** Genesis parentLatch sentinel (all-zero outpoint) when bootstrapping from a legacy tip. */
export const GENESIS_PARENT_LATCH = `${'0'.repeat(64)}_0` as const

/** Relative outpoint refs for remittance built before settle txid is known. */
export const RELATIVE_TIP = 'OUTPUT:0' as const
export const RELATIVE_LATCH = 'OUTPUT:1' as const

/** True when an on-chain value is the soft-latch amount (not a tip, not funds). */
export function isLatchDustSats(satoshis: number): boolean {
  return satoshis === LATCH_DUST_SATS
}

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
const RELATIVE_RE = /^OUTPUT:(\d+)$/i

export function toUnderscoreOutpoint(outpoint: string): string {
  const n = outpoint.trim()
  if (n.includes('_')) return n.toLowerCase()
  return n.replace(/\.(\d+)$/, '_$1').toLowerCase()
}

export function isRelativeOutpointRef(ref: string): boolean {
  return RELATIVE_RE.test(ref.trim())
}

export function isGenesisParentLatch(outpoint: string): boolean {
  return toUnderscoreOutpoint(outpoint) === GENESIS_PARENT_LATCH
}

export function isValidOutpoint(outpoint: string): boolean {
  if (isRelativeOutpointRef(outpoint)) return true
  const n = toUnderscoreOutpoint(outpoint)
  if (!OUTPOINT_RE.test(n)) return false
  const [txid, vout] = n.split('_')
  return Boolean(txid && txid.length === 64 && vout != null && /^\d+$/.test(vout))
}

/**
 * Resolve `OUTPUT:N` against the held tip's txid. Absolute outpoints pass through.
 */
export function resolveOutpointRef(ref: string, heldOutpoint: string): string {
  const raw = ref.trim()
  const m = RELATIVE_RE.exec(raw)
  if (!m) return toUnderscoreOutpoint(raw)
  const held = toUnderscoreOutpoint(heldOutpoint)
  const txid = held.split('_')[0]
  if (!txid || txid.length !== 64) return toUnderscoreOutpoint(raw)
  return `${txid}_${m[1]}`.toLowerCase()
}

/**
 * Soft-latch sends are live. The latch is a standard P2PKH output (so address
 * scanners still find it) with value {@link LATCH_DUST_SATS} (> 1). Receivers
 * must never treat that dust as a tip or as spendable funding.
 */
export function isLatchedSendEnabled(): boolean {
  return true
}

export function parseProvenanceV3(raw: unknown): ProvenanceV3 | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.v !== 3 || o.mode !== 'latched') return null
  if (typeof o.origin !== 'string' || typeof o.tip !== 'string') return null
  if (typeof o.latch !== 'string' || typeof o.parentLatch !== 'string') return null
  if ('beefB64' in o && o.beefB64 != null) return null
  if ('path' in o && Array.isArray(o.path)) return null

  const tip = isRelativeOutpointRef(o.tip) ? o.tip.trim().toUpperCase() : toUnderscoreOutpoint(o.tip)
  const latch = isRelativeOutpointRef(o.latch)
    ? o.latch.trim().toUpperCase()
    : toUnderscoreOutpoint(o.latch)

  return {
    v: 3,
    mode: 'latched',
    origin: toUnderscoreOutpoint(o.origin),
    tip,
    latch,
    parentLatch: toUnderscoreOutpoint(o.parentLatch),
    commitTxid: typeof o.commitTxid === 'string' ? o.commitTxid.trim().toLowerCase() : undefined,
    settleTxid: typeof o.settleTxid === 'string' ? o.settleTxid.trim().toLowerCase() : undefined,
  }
}

/**
 * Structural O(1) verify for v3 remittance (BRC-153).
 * Relative tip/latch refs resolve against the held tip's txid.
 */
export function verifyProvenanceV3(
  provenance: unknown,
  heldOutpoint: string,
): ProvenanceVerifyResult {
  const p = parseProvenanceV3(provenance)
  if (!p) return { proven: false, reason: 'missing or non-v3 latched provenance' }

  if (!isValidOutpoint(p.origin)) {
    return { proven: false, reason: 'invalid origin in v3 provenance' }
  }
  if (!isValidOutpoint(p.parentLatch)) {
    return { proven: false, reason: 'invalid parentLatch in v3 provenance' }
  }

  const held = toUnderscoreOutpoint(heldOutpoint)
  const tip = resolveOutpointRef(p.tip, held)
  const latch = resolveOutpointRef(p.latch, held)

  if (!isValidOutpoint(tip) || isRelativeOutpointRef(tip)) {
    return { proven: false, reason: 'invalid tip in v3 provenance' }
  }
  if (!isValidOutpoint(latch) || isRelativeOutpointRef(latch)) {
    return { proven: false, reason: 'invalid latch in v3 provenance' }
  }

  if (tip !== held) {
    return { proven: false, reason: 'tip does not match held outpoint' }
  }

  if (latch === tip || latch === p.parentLatch) {
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
  const tip = isRelativeOutpointRef(args.tip)
    ? args.tip.trim().toUpperCase()
    : toUnderscoreOutpoint(args.tip)
  const latch = isRelativeOutpointRef(args.latch)
    ? args.latch.trim().toUpperCase()
    : toUnderscoreOutpoint(args.latch)
  return {
    v: 3,
    mode: 'latched',
    origin: toUnderscoreOutpoint(args.origin),
    tip,
    latch,
    parentLatch: toUnderscoreOutpoint(args.parentLatch),
    ...(args.commitTxid ? { commitTxid: args.commitTxid.trim().toLowerCase() } : {}),
    ...(args.settleTxid ? { settleTxid: args.settleTxid.trim().toLowerCase() } : {}),
  }
}

/** Remittance for a settle-style soft-latch send (relative tip/latch). */
export function buildSoftLatchProvenanceV3(args: {
  origin: string
  parentLatch?: string | null
}): ProvenanceV3 {
  return buildProvenanceV3({
    origin: args.origin,
    tip: RELATIVE_TIP,
    latch: RELATIVE_LATCH,
    parentLatch: args.parentLatch?.trim()
      ? toUnderscoreOutpoint(args.parentLatch)
      : GENESIS_PARENT_LATCH,
  })
}

/** Tags for a latch output per BRC-153 (tip may be relative pre-txid). */
export function latchOutputTags(args: {
  origin: string
  tip: string
}): string[] {
  const tipTag = isRelativeOutpointRef(args.tip)
    ? args.tip.trim().toUpperCase()
    : toUnderscoreOutpoint(args.tip)
  return [
    LATCH_TAG,
    `origin:${toUnderscoreOutpoint(args.origin)}`,
    `tip:${tipTag}`,
  ]
}

export function isProvenanceV3(raw: unknown): boolean {
  return parseProvenanceV3(raw) != null
}

export type LatchListing = {
  outpoint: string
  origin: string
  tip: string
  satoshis: number
  lockingScript?: string
}

/**
 * Resolve which tip outpoint a latch listing claims (absolute or OUTPUT:N vs latch txid).
 */
export function resolveLatchTipClaim(latchOutpoint: string, tipTag: string): string {
  if (isRelativeOutpointRef(tipTag)) {
    return resolveOutpointRef(tipTag, latchOutpoint)
  }
  return toUnderscoreOutpoint(tipTag)
}

/** Advertised 1Sat BRC profile for manifest / capability negotiation (BRC-153). */
export type OneSatBrcCapabilities = {
  brcs: readonly string[]
  baskets: readonly string[]
  /** Soft-latch settle sends (tip + latch P2PKH). */
  latchedSend: boolean
  /** Provenance remittance versions this wallet can verify. */
  provenanceVerify: readonly string[]
}

export function getOneSatBrcCapabilities(): OneSatBrcCapabilities {
  return {
    brcs: ['147', '150', '153'],
    baskets: ['1sat', ONE_SAT_LATCH_BASKET],
    latchedSend: isLatchedSendEnabled(),
    provenanceVerify: ['v2', 'v3'],
  }
}
