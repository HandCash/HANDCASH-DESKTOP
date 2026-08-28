/**
 * Local BSV-21 icon bytes — P2P / own-tx path, not HTTP content indexers.
 * Keyed by icon outpoint (`txid_vout` or `txid.vout`).
 */
import { durableGetItem, durableSetItem } from './durableStorage'
import { normalizeTokenId } from './bsv21'

const STORAGE_KEY = 'handcash.bsv21.tokenIcons'

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
  if (entries.length > 200) {
    entries.sort((a, b) => (a[1]?.at ?? 0) - (b[1]?.at ?? 0))
    for (const [k] of entries.slice(0, entries.length - 200)) delete store[k!]
  }
  durableSetItem(STORAGE_KEY, JSON.stringify(store))
}

function bytesToB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s)
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function rememberTokenIcon(
  outpoint: string,
  body: Uint8Array,
  mime: string,
): void {
  const key = keyOf(outpoint)
  if (!key || body.length === 0) return
  const mimeSafe = (mime || 'application/octet-stream').split(';')[0]!.trim() || 'application/octet-stream'
  // Cap ~96 KiB — ticker icons should stay small; refuse huge blobs.
  if (body.length > 512 * 1024) return
  const store = readStore()
  store[key] = { mime: mimeSafe, b64: bytesToB64(body), at: Date.now() }
  writeStore(store)
}

export function getTokenIconRecord(outpoint: string | undefined | null): TokenIconRecord | null {
  if (!outpoint?.trim()) return null
  return readStore()[keyOf(outpoint)] ?? null
}

export function getTokenIconDataUrl(outpoint: string | undefined | null): string | undefined {
  const rec = getTokenIconRecord(outpoint)
  if (!rec) return undefined
  return `data:${rec.mime};base64,${rec.b64}`
}

export function tokenIconBytes(outpoint: string | undefined | null): Uint8Array | null {
  const rec = getTokenIconRecord(outpoint)
  if (!rec) return null
  try {
    return b64ToBytes(rec.b64)
  } catch {
    return null
  }
}
