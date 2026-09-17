import { durableGetItem, durableSetItem } from './durableStorage'
import { normalizeTxid, TXID_HEX_RE } from './txid'

type Entry = { at: number }

export type DurableTtlTxidMap = {
  has(txid: string): boolean
  /** When this txid was remembered, or null when it is not held. */
  rememberedAt(txid: string): number | null
  remember(txid: string): void
  forget(txid: string): void
  reset(): void
}

/**
 * Persisted set of txids with TTL + cap. Used by Arcade pin and ghost lists
 * so those stores cannot drift in parse / prune behavior.
 */
export function createDurableTtlTxidMap(opts: {
  key: string
  max: number
  ttlMs: number
}): DurableTtlTxidMap {
  let cache: Map<string, Entry> | null = null

  function load(): Map<string, Entry> {
    if (cache) return cache
    cache = new Map()
    try {
      const raw = durableGetItem(opts.key)
      if (!raw) return cache
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const now = Date.now()
      for (const [txid, value] of Object.entries(parsed)) {
        if (!TXID_HEX_RE.test(txid)) continue
        const at =
          value && typeof value === 'object' && typeof (value as Entry).at === 'number'
            ? (value as Entry).at
            : typeof value === 'number'
              ? value
              : 0
        if (now - at > opts.ttlMs) continue
        cache.set(txid.toLowerCase(), { at })
      }
    } catch {
      /* corrupt blob → empty */
    }
    return cache
  }

  function persist(): void {
    const map = load()
    const now = Date.now()
    const rows = [...map.entries()]
      .filter(([, e]) => now - e.at <= opts.ttlMs)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, opts.max)
    map.clear()
    const obj: Record<string, Entry> = {}
    for (const [txid, e] of rows) {
      map.set(txid, e)
      obj[txid] = e
    }
    durableSetItem(opts.key, JSON.stringify(obj))
  }

  return {
    has(txid: string): boolean {
      const id = normalizeTxid(txid)
      if (!id) return false
      const e = load().get(id)
      if (!e) return false
      if (Date.now() - e.at > opts.ttlMs) {
        load().delete(id)
        persist()
        return false
      }
      return true
    },
    rememberedAt(txid: string): number | null {
      const id = normalizeTxid(txid)
      if (!id) return null
      const e = load().get(id)
      if (!e) return null
      return Date.now() - e.at > opts.ttlMs ? null : e.at
    },
    remember(txid: string): void {
      const id = normalizeTxid(txid)
      if (!id) return
      load().set(id, { at: Date.now() })
      persist()
    },
    forget(txid: string): void {
      const id = normalizeTxid(txid)
      if (!id || !load().delete(id)) return
      persist()
    },
    reset(): void {
      cache = new Map()
      durableSetItem(opts.key, '{}')
    },
  }
}
