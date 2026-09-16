/**
 * Item art from bytes this device already holds — never a content indexer.
 *
 * An item's art is its origin inscription, and every way an item legitimately
 * arrives brings that inscription with it:
 *
 *   mint      the `createAction` this wallet signed carries the ord envelope
 *   held tip  an unmoved mint is its own origin, so its locking script has it
 *   received  the BRC-150 remittance BEEF spans tip→origin, envelope included
 *   restored  managed storage still has the origin transaction locally
 *
 * `contentUrlForOrigin` (GorillaPool `/content/`) is the last resort for an
 * origin whose bytes never reached us — an item swept from a legacy address,
 * say. It is also why a fresh mint used to paint the placeholder glyph for as
 * long as the indexer took to notice it: the art was on the device the whole
 * time, addressed to a host that had never heard of the transaction.
 *
 * Keyed by origin (`txid_vout`) because that is what the art belongs to; the
 * tip moves, the origin does not.
 */
import { Beef } from '@bsv/sdk'
import { base64ToBytes, bytesToBase64 } from './base64Binary'
import { durableGetItem, durableSetItem } from './durableStorage'
import { imageMimeFor } from './inscriptionImage'
import { parseOrdEnvelope } from './ordinalOwnership'

const STORAGE_KEY = 'handcash.itemArt.v1'
/**
 * One item may not own the store. Studio items cap at 100 KB; this leaves room
 * for a hand-built inscription without letting a 2 MB ordinal in.
 */
const MAX_BYTES = 256 * 1024
const MAX_ENTRIES = 120

type ItemArtRecord = {
  mime: string
  /** Raw image bytes as base64 (no `data:` prefix). */
  b64: string
  at: number
}

type Store = Record<string, ItemArtRecord>

/**
 * Origins already looked at this session, hit or miss.
 *
 * A script cannot change, so one look is enough — and the list rebuilds on every
 * poll, so re-parsing a 100 KB envelope per card per pass is exactly the kind of
 * work that stalls a phone.
 */
const examined = new Set<string>()

export function originArtKey(origin: string): string {
  return origin.trim().toLowerCase().replace(/\.(\d+)$/, '_$1')
}

function readStore(): Store {
  try {
    const raw = durableGetItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Store
  } catch {
    return {}
  }
}

function writeStore(store: Store): void {
  const entries = Object.entries(store)
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => (a[1]?.at ?? 0) - (b[1]?.at ?? 0))
    for (const [key] of entries.slice(0, entries.length - MAX_ENTRIES)) delete store[key!]
  }
  try {
    durableSetItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Art is a cache of bytes we can rebuild from the transaction; losing it
    // costs a repaint, not the item.
  }
}

export function rememberItemArt(origin: string, body: Uint8Array, mime: string): void {
  const key = originArtKey(origin)
  if (!key || body.length === 0 || body.length > MAX_BYTES) return
  const mimeSafe = mime.split(';')[0]!.trim()
  if (!mimeSafe) return
  const store = readStore()
  store[key] = { mime: mimeSafe, b64: bytesToBase64(body), at: Date.now() }
  writeStore(store)
}

export function getItemArtRecord(origin: string | undefined | null): ItemArtRecord | null {
  if (!origin?.trim()) return null
  return readStore()[originArtKey(origin)] ?? null
}

export function getItemArtDataUrl(origin: string | undefined | null): string | undefined {
  const rec = getItemArtRecord(origin)
  if (!rec) return undefined
  return `data:${rec.mime};base64,${rec.b64}`
}

export function hasItemArt(origin: string | undefined | null): boolean {
  return !!getItemArtRecord(origin)
}

/** True when this origin has neither art nor a look this session. */
export function itemArtUnexamined(origin: string | undefined | null): boolean {
  if (!origin?.trim()) return false
  const key = originArtKey(origin)
  return !examined.has(key) && !readStore()[key]
}

function keepEnvelopeArt(origin: string, scriptHex: string | undefined): string | undefined {
  const env = parseOrdEnvelope(scriptHex)
  if (!env?.body.length) return undefined
  const mime = imageMimeFor(env.contentType, env.body)
  if (!mime) return undefined
  rememberItemArt(origin, env.body, mime)
  return getItemArtDataUrl(origin)
}

/**
 * Art from a locking script that *is* the origin output.
 *
 * Only ever call this with the script of the origin outpoint itself. A moved tip
 * is a plain P2PKH with no envelope, so a wrong pairing yields nothing rather
 * than the wrong picture — but keep the contract explicit anyway.
 */
export function rememberItemArtFromScript(
  origin: string,
  scriptHex: string | undefined,
): string | undefined {
  const key = originArtKey(origin)
  if (!key) return undefined
  const known = getItemArtDataUrl(key)
  if (known) return known
  if (!scriptHex || examined.has(key)) return undefined
  examined.add(key)
  return keepEnvelopeArt(key, scriptHex)
}

function splitOrigin(origin: string): { txid: string; vout: number } | null {
  const m = /^([0-9a-f]{64})_(\d+)$/.exec(originArtKey(origin))
  if (!m) return null
  return { txid: m[1]!, vout: Number(m[2]) }
}

function scriptHexFromBeef(beef: Beef, txid: string, vout: number): string | undefined {
  const tx = beef.findTxid(txid)?.tx ?? beef.findAtomicTransaction(txid)
  return tx?.outputs?.[vout]?.lockingScript?.toHex()
}

/** Art from a BEEF that contains the origin transaction. */
export function rememberItemArtFromBeef(origin: string, beef: Beef): string | undefined {
  const key = originArtKey(origin)
  const parts = splitOrigin(key)
  if (!parts) return undefined
  const known = getItemArtDataUrl(key)
  if (known) return known
  examined.add(key)
  try {
    return keepEnvelopeArt(key, scriptHexFromBeef(beef, parts.txid, parts.vout))
  } catch {
    return undefined
  }
}

/**
 * Art from a peer's BRC-150 remittance.
 *
 * The remittance BEEF spans tip→origin — that is what makes the item provable
 * offline — so the picture arrived with the proof. Nothing here trusts the
 * remittance: a body that does not decode to an image is simply not kept.
 */
export function rememberItemArtFromProvenance(provenance: unknown): string | undefined {
  if (!provenance || typeof provenance !== 'object') return undefined
  const p = provenance as { origin?: unknown; beefB64?: unknown }
  if (typeof p.origin !== 'string' || typeof p.beefB64 !== 'string') return undefined
  const key = originArtKey(p.origin)
  if (!splitOrigin(key)) return undefined
  const known = getItemArtDataUrl(key)
  if (known) return known
  if (examined.has(key)) return undefined
  examined.add(key)
  try {
    const beef = Beef.fromBinary(Array.from(base64ToBytes(p.beefB64)))
    return rememberItemArtFromBeef(key, beef)
  } catch {
    return undefined
  }
}

export function resetLocalItemArtForTests(): void {
  examined.clear()
  try {
    durableSetItem(STORAGE_KEY, '{}')
  } catch {
    /* no storage in this environment */
  }
}
