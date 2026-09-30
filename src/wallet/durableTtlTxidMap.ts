import { durableGetItem, durableSetItem } from './durableStorage'
import { normalizeTxid } from './txid'

type Entry = { at: number }

export type DurableTtlTxidMap = {
  has(txid: string): boolean
  /** When this txid was remembered, or null when it is not held. */
  rememberedAt(txid: string): number | null
  /** Live (un-expired) entry count. */
  size(): number
  /** Live entries, oldest first. */
  entries(): Array<{ txid: string; at: number }>
  remember(txid: string): void
  /** One write for many keys. */
  rememberMany(txids: Iterable<string>): void
  /** Stamp `at` only when missing or older — never moves a first-seen forward. */
  rememberOldest(txid: string, at: number): number | null
  forget(txid: string): void
  forgetMany(txids: Iterable<string>): void
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
  /** Canonical key, or null to refuse it. Defaults to a lowercase txid. */
  normalize?: (raw: string) => string | null
}): DurableTtlTxidMap {
  const normalizeKey = opts.normalize ?? normalizeTxid
  let cache: Map<string, Entry> | null = null

  function load(): Map<string, Entry> {
    if (cache) return cache
    cache = new Map()
    try {
      const raw = durableGetItem(opts.key)
      if (!raw) return cache
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const now = Date.now()
      for (const [raw, value] of Object.entries(parsed)) {
        const txid = normalizeKey(raw)
        if (!txid) continue
        const at =
          value && typeof value === 'object' && typeof (value as Entry).at === 'number'
            ? (value as Entry).at
            : typeof value === 'number'
              ? value
              : 0
        if (now - at > opts.ttlMs) continue
        cache.set(txid, { at })
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
      const id = normalizeKey(txid)
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
      const id = normalizeKey(txid)
      if (!id) return null
      const e = load().get(id)
      if (!e) return null
      return Date.now() - e.at > opts.ttlMs ? null : e.at
    },
    size(): number {
      const now = Date.now()
      let live = 0
      for (const e of load().values()) if (now - e.at <= opts.ttlMs) live += 1
      return live
    },
    entries(): Array<{ txid: string; at: number }> {
      const now = Date.now()
      return [...load().entries()]
        .filter(([, e]) => now - e.at <= opts.ttlMs)
        .map(([txid, e]) => ({ txid, at: e.at }))
        .sort((a, b) => a.at - b.at)
    },
    remember(txid: string): void {
      const id = normalizeKey(txid)
      if (!id) return
      load().set(id, { at: Date.now() })
      persist()
    },
    rememberMany(txids: Iterable<string>): void {
      const map = load()
      const at = Date.now()
      let changed = false
      for (const raw of txids) {
        const id = normalizeKey(raw)
        if (!id) continue
        map.set(id, { at })
        changed = true
      }
      if (changed) persist()
    },
    rememberOldest(txid: string, at: number): number | null {
      const id = normalizeKey(txid)
      if (!id || !Number.isFinite(at) || at <= 0) return this.rememberedAt(txid)
      const map = load()
      const existing = map.get(id)?.at
      const next = existing != null && existing > 0 ? Math.min(existing, at) : at
      if (existing === next) return existing
      map.set(id, { at: next })
      persist()
      return next
    },
    forget(txid: string): void {
      const id = normalizeKey(txid)
      if (!id || !load().delete(id)) return
      persist()
    },
    forgetMany(txids: Iterable<string>): void {
      const map = load()
      let changed = false
      for (const raw of txids) {
        const id = normalizeKey(raw)
        if (id && map.delete(id)) changed = true
      }
      if (changed) persist()
    },
    reset(): void {
      cache = new Map()
      durableSetItem(opts.key, '{}')
    },
  }
}
