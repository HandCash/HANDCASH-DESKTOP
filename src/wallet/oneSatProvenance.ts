/**
 * BRC-150 provenance remittance for basket `1sat` (+ recursive inscription tips).
 *
 * Oversized remittance edge case is isolated here: never truncate path/beef —
 * omit provenance and leave identity unproven (BRC-150).
 *
 * Tip rewrite after createAction (new outpoint unknown pre-broadcast) is best-effort:
 * we build for the known input tip when beef is available; receivers verify strictly
 * against the tip they hold.
 */
import { Beef } from '@bsv/sdk'
import type { ActiveWallet } from './session'
import {
  parseProvenanceV3,
  type ProvenanceV3,
  type ProvenanceVerifyResult,
} from './oneSatLatch'
import { hasOrdEnvelope } from './ordinalOwnership'

/** Soft cap on `beefB64` characters (~300KB binary). Over → omit, don’t truncate. */
export const REMITTANCE_MAX_BEEF_B64_CHARS = 400_000

export type ProvenanceV2 = {
  v: 2
  origin: string
  tip: string
  path: string[]
  beefB64: string
  contentType?: string
}

export type { ProvenanceVerifyResult, ProvenanceV3 } from './oneSatLatch'
export { parseProvenanceV3, verifyProvenanceV3 } from './oneSatLatch'

export type ProvenanceRemittance = ProvenanceV2 | ProvenanceV3

/**
 * Recover the actual one-sat spend path already present in a BEEF.
 *
 * This is the deliberately O(N) BRC-150 fallback. It runs on the sender when
 * hardened BRC-156 is unavailable; receivers then verify the explicit path.
 * Returning `[tip, origin]` for a deep transfer is not a shortcut — it is an
 * invalid proof because the tip transaction does not directly spend genesis.
 */
export function deriveOneSatPathFromBeef(
  beef: Beef,
  tipOutpoint: string,
  originOutpoint: string,
): string[] | null {
  const tip = toUnderscore(tipOutpoint).toLowerCase()
  const origin = toUnderscore(originOutpoint).toLowerCase()
  const pointRe = /^([0-9a-f]{64})_(\d+)$/
  if (!pointRe.test(tip) || !pointRe.test(origin)) return null
  if (tip === origin) return [tip]

  const memo = new Map<string, string[] | null>()
  const visiting = new Set<string>()

  const walk = (point: string): string[] | null => {
    if (point === origin) return [origin]
    if (memo.has(point)) return memo.get(point) ?? null
    if (visiting.has(point)) return null
    visiting.add(point)

    const match = pointRe.exec(point)
    if (!match) return null
    const tx = beef.findTxid(match[1]!)?.tx
    if (!tx) return null

    for (const input of tx.inputs) {
      const parentTxid = String(input.sourceTXID).toLowerCase()
      const parentVout = input.sourceOutputIndex
      if (!/^[0-9a-f]{64}$/.test(parentTxid) || !Number.isSafeInteger(parentVout)) continue
      const parentTx = beef.findTxid(parentTxid)?.tx
      const parentOutput = parentTx?.outputs[parentVout]
      if (!parentOutput || parentOutput.satoshis !== 1) continue
      const parent = `${parentTxid}_${parentVout}`
      const suffix = walk(parent)
      if (suffix) {
        const result = [point, ...suffix]
        memo.set(point, result)
        visiting.delete(point)
        return result
      }
    }

    visiting.delete(point)
    memo.set(point, null)
    return null
  }

  return walk(tip)
}

/**
 * Rebuild a legacy BRC-150 path without trusting an indexer identity.
 *
 * Every candidate edge must be an exact one-sat input. If independent one-sat
 * parents lead to different `ord` origins the sat path is ambiguous and this
 * returns null rather than choosing whichever input an indexer happens to name.
 */
export function rebuildProvenanceV2FromBeef(
  beef: Beef,
  tipOutpoint: string,
): ProvenanceV2 | null {
  const tip = toUnderscore(tipOutpoint).toLowerCase()
  const pointRe = /^([0-9a-f]{64})_(\d+)$/
  if (!pointRe.test(tip)) return null

  type Candidate = { origin: string; path: string[] }
  const memo = new Map<string, Candidate | null>()
  const visiting = new Set<string>()

  const walk = (point: string): Candidate | null => {
    if (memo.has(point)) return memo.get(point) ?? null
    if (visiting.has(point)) return null
    visiting.add(point)

    const match = pointRe.exec(point)
    const tx = match ? beef.findTxid(match[1]!)?.tx : undefined
    const output = tx?.outputs[Number(match?.[2])]
    if (!tx || !output || output.satoshis !== 1) {
      visiting.delete(point)
      memo.set(point, null)
      return null
    }

    const parents: Candidate[] = []
    for (const input of tx.inputs) {
      const parentTxid = String(input.sourceTXID).toLowerCase()
      const parentVout = input.sourceOutputIndex
      const parentOutput = beef.findTxid(parentTxid)?.tx?.outputs[parentVout]
      if (!parentOutput || parentOutput.satoshis !== 1) continue
      const candidate = walk(`${parentTxid}_${parentVout}`)
      if (candidate) parents.push(candidate)
    }

    const origins = new Set(parents.map((candidate) => candidate.origin))
    let result: Candidate | null = null
    if (origins.size === 1) {
      const longest = parents
        .slice()
        .sort((a, b) => b.path.length - a.path.length)[0]!
      result = { origin: longest.origin, path: [point, ...longest.path] }
    } else if (origins.size === 0 && hasOrdEnvelope(output.lockingScript?.toHex())) {
      result = { origin: point, path: [point] }
    }

    visiting.delete(point)
    memo.set(point, result)
    return result
  }

  const candidate = walk(tip)
  if (!candidate) return null
  const tipTxid = tip.slice(0, 64)
  let binary: number[]
  try {
    binary = beef.toBinaryAtomic(tipTxid)
  } catch {
    return null
  }
  const provenance: ProvenanceV2 = {
    v: 2,
    origin: candidate.origin,
    tip,
    path: candidate.path,
    beefB64: bytesToBase64(binary),
  }
  return verifyProvenanceV2(provenance, tip).proven ? provenance : null
}

function toUnderscore(outpoint: string): string {
  const n = outpoint.trim()
  if (n.includes('_')) return n
  return n.replace(/\.(\d+)$/, '_$1')
}

function toDot(outpoint: string): string {
  const n = outpoint.trim()
  if (n.includes('.')) return n
  return n.replace(/_(\d+)$/, '.$1')
}

function bytesToBase64(bytes: number[] | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]!)
  return btoa(s)
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Isolated size gate — truncate is forbidden. */
export function provenanceFitsBudget(p: ProvenanceV2): boolean {
  return typeof p.beefB64 === 'string' && p.beefB64.length <= REMITTANCE_MAX_BEEF_B64_CHARS
}

export function parseProvenanceV2(raw: unknown): ProvenanceV2 | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.v !== 2) return null
  if (typeof o.origin !== 'string' || typeof o.tip !== 'string') return null
  if (typeof o.beefB64 !== 'string' || !o.beefB64) return null
  if (!Array.isArray(o.path) || o.path.length < 1) return null
  if (!o.path.every((x) => typeof x === 'string')) return null
  return {
    v: 2,
    origin: toUnderscore(o.origin),
    tip: toUnderscore(o.tip),
    path: (o.path as string[]).map(toUnderscore),
    beefB64: o.beefB64,
    contentType: typeof o.contentType === 'string' ? o.contentType : undefined,
  }
}

/**
 * Structural + BEEF validity check. Tip must match the held outpoint (dot or underscore).
 */
export function verifyProvenanceV2(
  provenance: unknown,
  heldOutpoint: string,
): ProvenanceVerifyResult {
  const p = parseProvenanceV2(provenance)
  if (!p) return { proven: false, reason: 'missing or non-v2 provenance' }
  if (!provenanceFitsBudget(p)) return { proven: false, reason: 'remittance over size budget' }
  if (p.path[0] !== p.tip) return { proven: false, reason: 'path[0] !== tip' }
  if (p.path[p.path.length - 1] !== p.origin) {
    return { proven: false, reason: 'path does not end at origin' }
  }
  const held = toUnderscore(heldOutpoint)
  if (p.tip !== held) return { proven: false, reason: 'tip does not match held outpoint' }

  try {
    const beef = Beef.fromBinary(base64ToBytes(p.beefB64))
    // A txid-only entry is only legal when the receiver independently trusts
    // that transaction. This verifier has no such trust input, so every path
    // transaction must be present and structurally proven by the BEEF.
    const { valid } = beef.verifyValid(false)
    if (!valid) return { proven: false, reason: 'beef structurally invalid' }

    const tipTxid = p.tip.slice(0, 64).toLowerCase()
    if (beef.atomicTxid && beef.atomicTxid.toLowerCase() !== tipTxid) {
      return { proven: false, reason: 'AtomicBEEF subject is not the tip transaction' }
    }
    if (beef.atomicTxid && !beef.isAtomic(tipTxid)) {
      return { proven: false, reason: 'AtomicBEEF dependency graph is invalid' }
    }

    const parsedPath: Array<{ normalized: string; txid: string; vout: number }> = []
    for (const outpoint of p.path) {
      const normalized = toUnderscore(outpoint).toLowerCase()
      const match = /^([0-9a-f]{64})_(\d+)$/.exec(normalized)
      if (!match) return { proven: false, reason: `invalid path outpoint: ${outpoint}` }
      const vout = Number(match[2])
      if (!Number.isSafeInteger(vout)) {
        return { proven: false, reason: `invalid path output index: ${outpoint}` }
      }
      parsedPath.push({ normalized, txid: match[1]!, vout })
    }

    for (const point of parsedPath) {
      const tx = beef.findTxid(point.txid)?.tx
      if (!tx) return { proven: false, reason: `path transaction missing: ${point.txid}` }
      const output = tx.outputs[point.vout]
      if (!output) {
        return { proven: false, reason: `path output missing: ${point.normalized}` }
      }
      if (output.satoshis !== 1) {
        return { proven: false, reason: `path output is not one satoshi: ${point.normalized}` }
      }
    }

    // `path` is ordered tip → origin. Every child transaction must spend the
    // exact parent outpoint; merely including both txs in a valid BEEF does not
    // prove the ordinal sat moved between them.
    for (let i = 0; i + 1 < parsedPath.length; i++) {
      const child = parsedPath[i]!
      const parent = parsedPath[i + 1]!
      if (child.txid === parent.txid) continue
      const childTx = beef.findTxid(child.txid)?.tx
      const spendsParent = childTx?.inputs.some(
        (input) =>
          String(input.sourceTXID).toLowerCase() === parent.txid &&
          input.sourceOutputIndex === parent.vout,
      )
      if (!spendsParent) {
        return {
          proven: false,
          reason: `${child.normalized} does not spend parent ${parent.normalized}`,
        }
      }
    }

    const origin = parsedPath[parsedPath.length - 1]!
    const originTx = beef.findTxid(origin.txid)?.tx
    const originScript = originTx?.outputs[origin.vout]?.lockingScript?.toHex()
    if (!hasOrdEnvelope(originScript)) {
      return { proven: false, reason: 'origin output has no valid ord envelope' }
    }
  } catch (err) {
    return {
      proven: false,
      reason: err instanceof Error ? err.message : 'beef parse failed',
    }
  }
  return { proven: true, reason: null }
}

/**
 * Authenticity verify for collectables.
 *
 * Soft-latch v3 remittance is structural only (outpoint shape / tip match) — it is
 * NOT lossless tip→origin proof. Prefer BRC-150 v2 whenever present. Bare v3 does
 * not mark an item as proven until Phase 3 inductive latch verify exists.
 */
export function verifyProvenance(
  provenance: unknown,
  heldOutpoint: string,
): ProvenanceVerifyResult {
  if (parseProvenanceV2(provenance)) {
    return verifyProvenanceV2(provenance, heldOutpoint)
  }
  if (parseProvenanceV3(provenance)) {
    return {
      proven: false,
      reason:
        'v3 soft-latch remittance is not authenticity proof — need v2 BEEF or hardened latch induction',
    }
  }
  return { proven: false, reason: 'missing provenance' }
}

/**
 * Build v2 remittance for a known tip outpoint (usually the UTXO being spent).
 * Returns null when beef unavailable or over budget (omit — do not truncate).
 */
export async function tryBuildProvenanceV2(args: {
  tipOutpoint: string
  origin: string
  wallet: ActiveWallet
  contentType?: string
  /** Optional prior path tip→…→origin (underscore). */
  path?: string[]
  /**
   * Tip BEEF already fetched for this send. Reusing it avoids a second
   * `getBeefForTxid` round trip that otherwise dominates soft-latch signing.
   */
  inputBeef?: number[]
}): Promise<ProvenanceV2 | null> {
  const tip = toUnderscore(args.tipOutpoint)
  const origin = toUnderscore(args.origin)
  const tipDot = toDot(tip)
  const [txid] = tipDot.split('.')
  if (!txid) return null

  try {
    let beef: Beef | null = null
    if (args.inputBeef?.length) {
      try {
        const fromInput = Beef.fromBinary(args.inputBeef)
        if (fromInput.findTxid(txid)?.tx) beef = fromInput
      } catch {
        // Fall through to a fresh fetch.
      }
    }
    if (!beef) {
      if (!args.wallet.services?.getBeefForTxid) return null
      const { getBeefForTxidCached } = await import('./beefCache')
      beef = await getBeefForTxidCached(args.wallet, txid)
    }
    if (!beef) return null
    let bin: number[]
    try {
      bin = beef.toBinaryAtomic(txid)
    } catch {
      bin = typeof beef.toBinary === 'function' ? beef.toBinary() : []
    }
    if (!bin.length) return null
    const path =
      args.path && args.path.length > 0
        ? args.path.map(toUnderscore)
        : deriveOneSatPathFromBeef(beef, tip, origin)
    if (!path || path[0] !== tip || path[path.length - 1] !== origin) {
      console.warn('[brc-150] omit provenance — no complete one-sat path to origin')
      return null
    }
    const beefB64 = bytesToBase64(bin)
    const provenance: ProvenanceV2 = {
      v: 2,
      origin,
      tip,
      path,
      beefB64,
      ...(args.contentType ? { contentType: args.contentType } : {}),
    }
    if (!provenanceFitsBudget(provenance)) {
      try {
        const { appendAppLog } = await import('./appLog')
        appendAppLog(
          'info',
          `[brc-150] omit provenance — beefB64 ${beefB64.length} > ${REMITTANCE_MAX_BEEF_B64_CHARS}`,
        )
      } catch {
        /* ignore */
      }
      return null
    }
    const check = verifyProvenanceV2(provenance, tipDot)
    if (!check.proven) return null
    return provenance
  } catch (err) {
    console.warn('[brc-150] build provenance failed', err)
    return null
  }
}

/**
 * Remittance for a collectable send.
 *
 * Soft-latch still creates the companion 2-sat latch UTXO, but authenticity is
 * BRC-150 v2 (full tip→origin BEEF). Shipping structural v3 alone was a fake
 * "proven" flag — do not do that.
 */
export async function tryBuildProvenanceForSend(args: {
  tipOutpoint: string
  origin: string
  wallet: ActiveWallet
  contentType?: string
  path?: string[]
  parentLatch?: string | null
  inputBeef?: number[]
}): Promise<ProvenanceRemittance | null> {
  void args.parentLatch
  return tryBuildProvenanceV2(args)
}

/** Merge display fields + optional provenance into customInstructions JSON. */
export function buildCollectableCustomInstructions(args: {
  origin: string
  name: string
  app?: string
  provenance?: ProvenanceRemittance | null
}): string {
  const body: Record<string, unknown> = {
    origin: toUnderscore(args.origin),
    name: args.name,
  }
  if (args.app) body.app = args.app
  if (args.provenance) body.provenance = args.provenance
  return JSON.stringify(body)
}

/**
 * `internalizeAction` caps `customInstructions` at 1000 characters.
 *
 * The cap lives in the SDK's own validator, so it is not negotiable and it is
 * not a storage detail we can widen: an over-long value throws before anything
 * is written, and the whole transaction's outputs are lost with it. A BRC-150
 * v2 remittance is ~400k characters, so attaching one here fails 100% of the
 * time — every incoming ordinal, silently, forever.
 *
 * Dropping the BEEF costs nothing that matters. It was never received from the
 * sender; it is built locally from chain data, and `verifyItemAuthenticity`
 * rebuilds it on demand and caches the verdict. What must survive is the
 * identity the item cannot be displayed or spent without.
 */
export const INTERNALIZE_CUSTOM_INSTRUCTIONS_MAX = 1000

export function buildInternalizeCustomInstructions(args: {
  origin: string
  name: string
  app?: string
}): string {
  const full = buildCollectableCustomInstructions(args)
  if (full.length <= INTERNALIZE_CUSTOM_INSTRUCTIONS_MAX) return full

  // Only a pathological name/app can get here. Origin is load-bearing, so the
  // free-text fields give way rather than the identity.
  const origin = toUnderscore(args.origin)
  const fixed = JSON.stringify({ origin, name: '' }).length
  const budget = Math.max(0, INTERNALIZE_CUSTOM_INSTRUCTIONS_MAX - fixed - 16)
  return JSON.stringify({ origin, name: args.name.slice(0, budget) })
}
