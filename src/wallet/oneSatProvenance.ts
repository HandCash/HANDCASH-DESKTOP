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
  verifyProvenanceV3,
  type ProvenanceV3,
  type ProvenanceVerifyResult,
} from './oneSatLatch'

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
    const { valid } = beef.verifyValid(true)
    if (!valid) return { proven: false, reason: 'beef structurally invalid' }
  } catch (err) {
    return {
      proven: false,
      reason: err instanceof Error ? err.message : 'beef parse failed',
    }
  }
  return { proven: true, reason: null }
}

/**
 * Prefer BRC-151 v3 (latched) when present; otherwise BRC-150 v2 BEEF path.
 */
export function verifyProvenance(
  provenance: unknown,
  heldOutpoint: string,
): ProvenanceVerifyResult {
  if (parseProvenanceV3(provenance)) {
    return verifyProvenanceV3(provenance, heldOutpoint)
  }
  return verifyProvenanceV2(provenance, heldOutpoint)
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
}): Promise<ProvenanceV2 | null> {
  const tip = toUnderscore(args.tipOutpoint)
  const origin = toUnderscore(args.origin)
  const tipDot = toDot(tip)
  const [txid] = tipDot.split('.')
  if (!txid) return null

  const path =
    args.path && args.path.length > 0
      ? args.path.map(toUnderscore)
      : tip === origin
        ? [tip]
        : [tip, origin]

  if (path[0] !== tip || path[path.length - 1] !== origin) return null

  try {
    if (!args.wallet.services?.getBeefForTxid) return null
    const beef = await args.wallet.services.getBeefForTxid(txid)
    if (!beef) return null
    let bin: number[]
    try {
      bin = beef.toBinaryAtomic(txid)
    } catch {
      bin = typeof beef.toBinary === 'function' ? beef.toBinary() : []
    }
    if (!bin.length) return null
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
