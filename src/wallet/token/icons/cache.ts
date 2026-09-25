import { storageRegistry } from '../../../storage/registry'
/**
 * Local BSV-21 icon bytes — P2P / own-tx path, not HTTP content indexers.
 * Keyed by icon outpoint (`txid_vout` or `txid.vout`).
 */
import { durableGetItem, durableSetItem } from '../../durableStorage'
import { normalizeTokenId } from '../types'
import { base64ToBytes, bytesToBase64 } from '../../base64Binary'

const STORAGE_KEY = storageRegistry.tokenIcons.key
const MAX_ICON_BYTES = 96 * 1024
/** Icons are reconstructable; keep their share of Android's ~5MB store small. */
const MAX_STORE_CHARS = 256 * 1024
const MAX_ENTRIES = 200

export type TokenIconRecord = {
  mime: string
  /** Raw image bytes as base64 (no data: prefix). */
  b64: string
  at: number
}

type Store = Record<string, TokenIconRecord>

function keyOf(outpoint: string): string {
  return (normalizeTokenId(outpoint) ?? outpoint.trim().toLowerCase().replace('.', '_')).replace(
    /\./g,
    '_',
  )
}

/**
 * Parsed store and data URLs, keyed by the raw string they came from.
 *
 * The blob carries the icon bytes, so every token row that asked for its icon
 * while rendering was parsing the whole cache. Read-only — `rememberTokenIcon`
 * clones before `writeStore`, which prunes by deleting keys.
 */
let cachedRaw: string | null = null
let cachedStore: Store = {}
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
    for (const [k] of entries.slice(0, entries.length - MAX_ENTRIES)) delete store[k!]
  }
  let body = JSON.stringify(store)
  for (const [key] of entries) {
    if (body.length <= MAX_STORE_CHARS || Object.keys(store).length <= 1) break
    delete store[key]
    body = JSON.stringify(store)
  }
  durableSetItem(STORAGE_KEY, body)
}

export function rememberTokenIcon(
  outpoint: string,
  body: Uint8Array,
  mime: string,
): void {
  const key = keyOf(outpoint)
  if (!key || body.length === 0) return
  const mimeSafe = (mime || 'application/octet-stream').split(';')[0]!.trim() || 'application/octet-stream'
  // Ticker icons should stay small; one icon must never own the cache budget.
  if (body.length > MAX_ICON_BYTES) return
  const store = { ...readStore() }
  store[key] = { mime: mimeSafe, b64: bytesToBase64(body), at: Date.now() }
  writeStore(store)
}

export function getTokenIconRecord(outpoint: string | undefined | null): TokenIconRecord | null {
  if (!outpoint?.trim()) return null
  return readStore()[keyOf(outpoint)] ?? null
}

export function getTokenIconDataUrl(outpoint: string | undefined | null): string | undefined {
  if (!outpoint?.trim()) return undefined
  const key = keyOf(outpoint)
  const store = readStore()
  const hit = cachedUrls.get(key)
  if (hit != null) return hit
  const rec = store[key]
  if (!rec) return undefined
  const url = `data:${rec.mime};base64,${rec.b64}`
  cachedUrls.set(key, url)
  return url
}

export function tokenIconBytes(outpoint: string | undefined | null): Uint8Array | null {
  const rec = getTokenIconRecord(outpoint)
  if (!rec) return null
  try {
    return base64ToBytes(rec.b64)
  } catch {
    return null
  }
}
