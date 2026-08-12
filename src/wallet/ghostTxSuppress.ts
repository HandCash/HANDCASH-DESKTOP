/**
 * Txids confirmed missing on-chain (indexer 404). Tip-hint polls must not keep
 * re-pinning Activity "Verifying…" for messages that will never ingest.
 */
import { durableGetItem, durableSetItem } from './durableStorage'

const KEY = 'handcash.wallet.ghostTx.v1'
const MAX = 500
/** Remember long enough that inbox ACKs stick across sessions. */
const TTL_MS = 30 * 24 * 60 * 60_000

type Entry = { at: number }

let cache: Map<string, Entry> | null = null

function load(): Map<string, Entry> {
  if (cache) return cache
  cache = new Map()
  try {
    const raw = durableGetItem(KEY)
    if (!raw) return cache
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const now = Date.now()
    for (const [txid, value] of Object.entries(parsed)) {
      if (!/^[0-9a-f]{64}$/i.test(txid)) continue
      const at =
        value && typeof value === 'object' && typeof (value as Entry).at === 'number'
          ? (value as Entry).at
          : typeof value === 'number'
            ? value
            : 0
      if (now - at > TTL_MS) continue
      cache.set(txid.toLowerCase(), { at })
    }
  } catch {
    // ignore
  }
  return cache
}

function persist(): void {
  const map = load()
  const now = Date.now()
  const rows = [...map.entries()]
    .filter(([, e]) => now - e.at <= TTL_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX)
  map.clear()
  const obj: Record<string, Entry> = {}
  for (const [txid, e] of rows) {
    map.set(txid, e)
    obj[txid] = e
  }
  durableSetItem(KEY, JSON.stringify(obj))
}

export function isGhostTxSuppressed(txid: string): boolean {
  const id = txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) return false
  const e = load().get(id)
  if (!e) return false
  if (Date.now() - e.at > TTL_MS) {
    load().delete(id)
    persist()
    return false
  }
  return true
}

export function rememberGhostTx(txid: string): void {
  const id = txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) return
  load().set(id, { at: Date.now() })
  persist()
}

export function forgetGhostTx(txid: string): void {
  const id = txid.trim().toLowerCase()
  if (!load().delete(id)) return
  persist()
}

export function __resetGhostTxSuppressForTests(): void {
  cache = new Map()
  durableSetItem(KEY, '{}')
}
