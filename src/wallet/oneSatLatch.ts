/**
 * BRC-156 latched 1Sat provenance — basket `1sat-latch`, v3 remittance, O(1) verify.
 *
 * Soft-latch (live): tip + latch are P2PKH outputs co-created in one settle-style
 * transfer. Remittance tip/latch may use relative `OUTPUT:N` refs resolved against
 * the held tip's txid (so remittance can be built before the settle txid is known).
 * Schema-2 / hardened Commit/Settle fields are parsed for compatibility only;
 * the wallet no longer creates or spends covenant tips.
 */
import { Hash, Utils } from '@bsv/sdk'

export type ProvenanceVerifyResult = {
  proven: boolean
  reason: string | null
}

/** Companion basket for proof latch UTXOs ([BRC-156]). */
export const ONE_SAT_LATCH_BASKET = '1sat-latch' as const

export const LATCH_TAG = 'latch:1sat' as const

export const LATCH_SCHEMA_VERSION = 1 as const

/** Hardened inductive latch state (Commit/Settle + originScriptHash binding). */
export const LATCH_SCHEMA_HARDENED = 2 as const

/**
 * Soft-latch P2PKH latch value / hardened discovery beacon ([BRC-156]).
 * Exactly **2 satoshis** — never 1 (that is a tip) — so address scanners still
 * find a plain P2PKH latch while receivers can classify it without a script marker.
 */
export const LATCH_DUST_SATS = 2 as const

/** Genesis parentLatch sentinel (all-zero outpoint) when bootstrapping from a legacy tip. */
export const GENESIS_PARENT_LATCH = `${'0'.repeat(64)}_0` as const

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
 * Structural O(1) verify for v3 remittance (BRC-156).
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

/** Tags for a latch output per BRC-156 (tip may be relative pre-txid). */
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

/**
 * Protocol marker for the on-chain latch state output.
 *
 * Baskets, tags and `customInstructions` are BRC-100 *local* state: none of it
 * reaches a counterparty who is paid at an address. A latch whose state lives
 * only in local metadata therefore proves an item arrived but cannot say which
 * item, which is what forced receivers back onto an indexer walk — the exact
 * O(N), third-party dependency this BRC exists to remove. Writing the state to
 * the settle transaction closes that gap: the receiver already fetches the
 * transaction to internalize it, so identity costs no extra round trip.
 */
export const LATCH_DATA_PROTOCOL = 'BRC156' as const

/** `OP_FALSE OP_RETURN` — provably unspendable, so this output carries no value. */
const OP_FALSE_OP_RETURN = '006a'

export type LatchState = {
  schema: number
  origin: string
  /** Tip this latch is paired with; `OUTPUT:0` until the settle txid exists. */
  tip: string
  parentLatch: string
  name?: string
  app?: string
  /** Content type of the inscription at origin, when the sender knows it. */
  mimeType?: string
  /** Schema 2: `"hardened"` when using the consensus covenant. */
  mode?: 'hardened'
  /** Schema 2: current hardened proof/latch outpoint (`OUTPUT:N` allowed). */
  latch?: string
  /** Schema 2: 2-sat P2PKH discovery beacon (`OUTPUT:N` allowed). */
  beacon?: string
  /** Schema 2: delayed proof from the previous owner's Commit. */
  proofOutpoint?: string
  /** Schema 2: lowercase SHA-256 of the origin locking script. Immutable. */
  originScriptHash?: string
  /** Schema 2: HASH160 of the recipient identity public key. */
  ownerKeyHash?: string
  /** Schema 2: Commit transaction id for the current pair. */
  commitTxid?: string
  /** Schema 2: `"SELF"` or settle txid once known. */
  settleTxid?: string
}

function pushData(bytes: number[]): string {
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
  if (bytes.length < 0x4c) return bytes.length.toString(16).padStart(2, '0') + hex
  if (bytes.length <= 0xff) return `4c${bytes.length.toString(16).padStart(2, '0')}` + hex
  if (bytes.length <= 0xffff) {
    const len = bytes.length
    const le = (len & 0xff).toString(16).padStart(2, '0') + ((len >> 8) & 0xff).toString(16).padStart(2, '0')
    return `4d${le}` + hex
  }
  throw new Error('latch state too large for a single pushdata')
}

function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text))
}

/**
 * Build the `OP_FALSE OP_RETURN BRC156 <json>` locking script for a latch state
 * output. Carried at 0 satoshis, so it never appears in an address UTXO scan
 * and never competes with the tip or the latch dust.
 */
export function buildLatchStateScript(state: LatchState): string {
  const schema = state.schema
  const tip = isRelativeOutpointRef(state.tip)
    ? state.tip.trim().toUpperCase()
    : toUnderscoreOutpoint(state.tip)
  const payload: Record<string, unknown> = {
    schema,
    origin: toUnderscoreOutpoint(state.origin),
    tip,
    parentLatch: toUnderscoreOutpoint(state.parentLatch),
  }

  if (schema >= LATCH_SCHEMA_HARDENED) {
    if (!state.originScriptHash || !isValidOriginScriptHash(state.originScriptHash)) {
      throw new Error('schema-2 latch state requires originScriptHash')
    }
    payload.mode = 'hardened'
    payload.originScriptHash = state.originScriptHash.trim().toLowerCase()
    if (!state.proofOutpoint || !isValidOutpoint(state.proofOutpoint)) {
      throw new Error('schema-2 latch state requires proofOutpoint')
    }
    payload.proofOutpoint = toUnderscoreOutpoint(state.proofOutpoint)
    if (state.latch) {
      payload.latch = isRelativeOutpointRef(state.latch)
        ? state.latch.trim().toUpperCase()
        : toUnderscoreOutpoint(state.latch)
    }
    if (state.beacon) {
      payload.beacon = isRelativeOutpointRef(state.beacon)
        ? state.beacon.trim().toUpperCase()
        : toUnderscoreOutpoint(state.beacon)
    }
    if (state.ownerKeyHash) {
      if (!/^[0-9a-f]{40}$/i.test(state.ownerKeyHash.trim())) {
        throw new Error('invalid ownerKeyHash')
      }
      payload.ownerKeyHash = state.ownerKeyHash.trim().toLowerCase()
    }
    if (state.commitTxid) {
      if (state.commitTxid.trim().length !== 64) throw new Error('invalid commitTxid')
      payload.commitTxid = state.commitTxid.trim().toLowerCase()
    }
    if (state.settleTxid) {
      const s = state.settleTxid.trim()
      if (s.toUpperCase() === 'SELF') payload.settleTxid = 'SELF'
      else if (s.length !== 64) throw new Error('invalid settleTxid')
      else payload.settleTxid = s.toLowerCase()
    }
  }

  if (state.name) payload.name = state.name.slice(0, 80)
  if (state.app) payload.app = state.app.slice(0, 40)
  if (state.mimeType) payload.mimeType = state.mimeType.slice(0, 60)

  return (
    OP_FALSE_OP_RETURN +
    pushData(utf8Bytes(LATCH_DATA_PROTOCOL)) +
    pushData(utf8Bytes(JSON.stringify(payload)))
  )
}

/** Read the pushdata payloads following `OP_FALSE OP_RETURN`. */
function readOpReturnPushes(scriptHex: string): number[][] | null {
  const hex = scriptHex.trim().toLowerCase()
  if (!hex.startsWith(OP_FALSE_OP_RETURN)) return null

  const bytes: number[] = []
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const byte = Number.parseInt(hex.slice(i, i + 2), 16)
    if (Number.isNaN(byte)) return null
    bytes.push(byte)
  }

  const pushes: number[][] = []
  let at = 2
  while (at < bytes.length) {
    const op = bytes[at]!
    at += 1
    let len: number
    if (op < 0x4c) {
      len = op
    } else if (op === 0x4c) {
      len = bytes[at] ?? -1
      at += 1
    } else if (op === 0x4d) {
      len = (bytes[at] ?? -1) | ((bytes[at + 1] ?? 0) << 8)
      at += 2
    } else {
      // Anything else is not a payload this codec wrote.
      return pushes
    }
    if (len < 0 || at + len > bytes.length) return pushes
    pushes.push(bytes.slice(at, at + len))
    at += len
  }
  return pushes
}

/** Parse a latch state output script. Returns null when it is not one. */
export function parseLatchStateScript(scriptHex: string): LatchState | null {
  const pushes = readOpReturnPushes(scriptHex)
  if (!pushes || pushes.length < 2) return null

  const decoder = new TextDecoder()
  const protocol = decoder.decode(new Uint8Array(pushes[0]!))
  if (protocol !== LATCH_DATA_PROTOCOL) return null

  let raw: unknown
  try {
    raw = JSON.parse(decoder.decode(new Uint8Array(pushes[1]!)))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.origin !== 'string' || typeof o.tip !== 'string') return null
  if (!isValidOutpoint(o.origin)) return null

  const tip = isRelativeOutpointRef(o.tip)
    ? o.tip.trim().toUpperCase()
    : toUnderscoreOutpoint(o.tip)
  if (!isValidOutpoint(tip)) return null

  const parentLatch =
    typeof o.parentLatch === 'string' && isValidOutpoint(o.parentLatch)
      ? toUnderscoreOutpoint(o.parentLatch)
      : GENESIS_PARENT_LATCH

  const schema = typeof o.schema === 'number' ? o.schema : LATCH_SCHEMA_VERSION
  const originScriptHash =
    typeof o.originScriptHash === 'string' && isValidOriginScriptHash(o.originScriptHash)
      ? o.originScriptHash.trim().toLowerCase()
      : undefined
  if (schema >= LATCH_SCHEMA_HARDENED && !originScriptHash) return null

  const latch =
    typeof o.latch === 'string'
      ? isRelativeOutpointRef(o.latch)
        ? o.latch.trim().toUpperCase()
        : isValidOutpoint(o.latch)
          ? toUnderscoreOutpoint(o.latch)
          : undefined
      : undefined

  const beacon =
    typeof o.beacon === 'string'
      ? isRelativeOutpointRef(o.beacon)
        ? o.beacon.trim().toUpperCase()
        : isValidOutpoint(o.beacon)
          ? toUnderscoreOutpoint(o.beacon)
          : undefined
      : undefined

  const ownerKeyHash =
    typeof o.ownerKeyHash === 'string' && /^[0-9a-f]{40}$/i.test(o.ownerKeyHash.trim())
      ? o.ownerKeyHash.trim().toLowerCase()
      : undefined

  const proofOutpoint =
    typeof o.proofOutpoint === 'string' &&
    isValidOutpoint(o.proofOutpoint)
      ? toUnderscoreOutpoint(o.proofOutpoint)
      : undefined
  if (schema >= LATCH_SCHEMA_HARDENED && !proofOutpoint) return null

  const commitTxid =
    typeof o.commitTxid === 'string' && o.commitTxid.trim().length === 64
      ? o.commitTxid.trim().toLowerCase()
      : undefined

  let settleTxid: string | undefined
  if (typeof o.settleTxid === 'string') {
    const s = o.settleTxid.trim()
    if (s.toUpperCase() === 'SELF') settleTxid = 'SELF'
    else if (s.length === 64) settleTxid = s.toLowerCase()
  }

  return {
    schema,
    origin: toUnderscoreOutpoint(o.origin),
    tip,
    parentLatch,
    name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 80) : undefined,
    app: typeof o.app === 'string' && o.app.trim() ? o.app.trim().slice(0, 40) : undefined,
    mimeType:
      typeof o.mimeType === 'string' && o.mimeType.trim()
        ? o.mimeType.trim().slice(0, 60)
        : undefined,
    ...(schema >= LATCH_SCHEMA_HARDENED
      ? {
          mode: 'hardened' as const,
          originScriptHash,
          proofOutpoint,
          ...(latch ? { latch } : {}),
          ...(beacon ? { beacon } : {}),
          ...(ownerKeyHash ? { ownerKeyHash } : {}),
          ...(commitTxid ? { commitTxid } : {}),
          ...(settleTxid ? { settleTxid } : {}),
        }
      : {}),
  }
}

/**
 * Find latch state for a tip in the outputs of the transaction that delivered it.
 *
 * `tipVout` is matched against the state's `tip` so a batched settle carrying
 * several items cannot hand the wrong identity to a tip.
 */
export function findLatchStateForTip(
  outputs: Array<{ lockingScript?: string | null }>,
  tipVout: number,
): LatchState | null {
  for (const out of outputs) {
    if (!out?.lockingScript) continue
    const state = parseLatchStateScript(out.lockingScript)
    if (!state) continue
    const relative = RELATIVE_RE.exec(state.tip)
    if (relative) {
      if (Number(relative[1]) === tipVout) return state
      continue
    }
    const vout = Number(state.tip.split('_')[1])
    if (vout === tipVout) return state
  }
  return null
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

/** Advertised 1Sat BRC profile for manifest / capability negotiation (BRC-156). */
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
    brcs: ['147', '150', '156'],
    baskets: ['1sat', ONE_SAT_LATCH_BASKET],
    latchedSend: isLatchedSendEnabled(),
    provenanceVerify: ['v2', 'v3'],
  }
}
