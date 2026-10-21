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
import type { Beef } from '@bsv/sdk'
import { bytesToBase64 } from './base64Binary'
import { getComputePort } from './compute/computeClient'
import { durableGetItem, durableSetItem } from './durableStorage'
import {
  artFromScript,
  decodeItemArtFromProvenance,
  MAX_ITEM_ART_BYTES,
  originArtKey,
  scriptHexFromBeef,
  splitArtOrigin,
} from './itemArtDecode'
import type { ItemArt } from '../ports/computePort'

export { originArtKey } from './itemArtDecode'

const STORAGE_KEY = 'handcash.itemArt.v1'
const MAX_ENTRIES = 120
/** Shared origin storage is ~5MB on Android; art is a rebuildable cache. */
const MAX_STORE_CHARS = 512 * 1024

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

/**
 * Parsed store, keyed by the raw string it came from.
 *
 * The blob holds the base64 bodies themselves — up to `MAX_ENTRIES` records of
 * `MAX_BYTES` each — so parsing it is tens of megabytes of work. Every card
 * asks for its art while rendering, which made a single navigation into the
 * items list pay that parse once per card and freeze the renderer. A write
 * changes the raw string, so keying on it cannot serve a stale store.
 *
 * Read-only: `rememberItemArt` clones before handing the store to `writeStore`,
 * which prunes by deleting keys.
 */
let cachedRaw: string | null = null
let cachedStore: Store = {}
/** Data URLs are as large as the records; rebuild them only when the store changes. */
let cachedUrls = new Map<string, string>()

function readStore(): Store {
  try {
    const raw = durableGetItem(STORAGE_KEY)
    if (!raw) return {}
    if (raw === cachedRaw) return cachedStore
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    cachedRaw = raw
    cachedStore = parsed as Store
    cachedUrls = new Map()
    return cachedStore
  } catch {
    return {}
  }
}

function writeStore(store: Store): void {
  const entries = Object.entries(store).sort(
    (a, b) => (a[1]?.at ?? 0) - (b[1]?.at ?? 0),
  )
  if (entries.length > MAX_ENTRIES) {
    for (const [key] of entries.slice(0, entries.length - MAX_ENTRIES)) delete store[key!]
  }
  let body = JSON.stringify(store)
  // Count is not a byte budget: two large inscriptions can outweigh 120 tiny
  // ones. Drop oldest art until this cache leaves room for wallet state.
  for (const [key] of entries) {
    if (body.length <= MAX_STORE_CHARS || Object.keys(store).length <= 1) break
    delete store[key]
    body = JSON.stringify(store)
  }
  try {
    durableSetItem(STORAGE_KEY, body)
  } catch {
    // Art is a cache of bytes we can rebuild from the transaction; losing it
    // costs a repaint, not the item.
  }
}

export function rememberItemArt(origin: string, body: Uint8Array, mime: string): void {
  const key = originArtKey(origin)
  if (!key || body.length === 0 || body.length > MAX_ITEM_ART_BYTES) return
  const mimeSafe = mime.split(';')[0]!.trim()
  if (!mimeSafe) return
  const store = { ...readStore() }
  store[key] = { mime: mimeSafe, b64: bytesToBase64(body), at: Date.now() }
  writeStore(store)
}

export function getItemArtRecord(origin: string | undefined | null): ItemArtRecord | null {
  if (!origin?.trim()) return null
  return readStore()[originArtKey(origin)] ?? null
}

export function getItemArtDataUrl(origin: string | undefined | null): string | undefined {
  if (!origin?.trim()) return undefined
  const key = originArtKey(origin)
  const store = readStore()
  const hit = cachedUrls.get(key)
  if (hit != null) return hit
  const rec = store[key]
  if (!rec) return undefined
  const url = `data:${rec.mime};base64,${rec.b64}`
  cachedUrls.set(key, url)
  return url
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

function keepArt(origin: string, art: ItemArt | null): string | undefined {
  if (!art) return undefined
  rememberItemArt(origin, art.body, art.mime)
  return getItemArtDataUrl(origin)
}

function keepEnvelopeArt(origin: string, scriptHex: string | undefined): string | undefined {
  return keepArt(origin, artFromScript(scriptHex))
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

/** Art from a BEEF that contains the origin transaction. */
export function rememberItemArtFromBeef(origin: string, beef: Beef): string | undefined {
  const key = originArtKey(origin)
  const parts = splitArtOrigin(key)
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
  const request = unexaminedProvenance(provenance)
  if (typeof request !== 'object') return request
  return keepArt(request.origin, decodeItemArtFromProvenance(request))
}

/** {@link rememberItemArtFromProvenance} with the BEEF decoded on the compute worker. */
export async function rememberItemArtFromProvenanceOffThread(
  provenance: unknown,
): Promise<string | undefined> {
  const request = unexaminedProvenance(provenance)
  if (typeof request !== 'object') return request
  try {
    return keepArt(request.origin, await getComputePort().run('itemArtFromProvenance', request))
  } catch {
    return undefined
  }
}

/** Known art as a URL, nothing to do as undefined, else the request to decode (marked examined). */
function unexaminedProvenance(
  provenance: unknown,
): string | undefined | { origin: string; beefB64: string } {
  if (!provenance || typeof provenance !== 'object') return undefined
  const p = provenance as { origin?: unknown; beefB64?: unknown }
  if (typeof p.origin !== 'string' || typeof p.beefB64 !== 'string') return undefined
  const key = originArtKey(p.origin)
  if (!splitArtOrigin(key)) return undefined
  const known = getItemArtDataUrl(key)
  if (known) return known
  if (examined.has(key)) return undefined
  examined.add(key)
  return { origin: key, beefB64: p.beefB64 }
}

export function resetLocalItemArtForTests(): void {
  examined.clear()
  try {
    durableSetItem(STORAGE_KEY, '{}')
  } catch {
    /* no storage in this environment */
  }
}
