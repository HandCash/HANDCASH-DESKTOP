import { storageRegistry } from '../../storage/registry'
import { defaultLtcChain, type LtcChain } from './chain'
import { LTC_CHECKPOINT, type LtcCheckpoint } from './checkpoint'
import { parseLtcHeader, scryptPowHash, targetFromBits, type Bytes, type LtcHeader } from './litecoin'

/**
 * The wallet's own Litecoin header chain (SPV), so "buried" means on the
 * chain with the most work, not just under headers someone mined.
 *
 * It starts at the shipped checkpoint and only moves forward. A header is
 * taken once: it must link to the one before, carry exactly the bits
 * Litecoin's retarget rule gives it, meet them by scrypt, and not sit more
 * than two hours in the future. After that only its hash is kept, about
 * 18 KB a day. Nothing syncs until a burial is checked, and a check whose
 * block is already 6 deep on this chain reads no network at all.
 *
 * A block before the checkpoint is found by linking down to it by hash,
 * which needs no proof of work, up to {@link MAX_BACK_LINK} blocks.
 *
 * The chain object is the same for every coin; what a header must carry is
 * the coin's {@link HeaderRules} (Litecoin here, Bitcoin Cash in `bch/`).
 */

export const LTC_RETARGET_INTERVAL = 2016
const TARGET_TIMESPAN = 302_400
/** Mainnet `powLimit`: 20 leading zero bits. */
export const LTC_POW_LIMIT = (1n << 236n) - 1n
const MAX_FUTURE_S = 2 * 60 * 60
/** Deepest reorganization the chain follows. */
const MAX_REORG = 100
/** Most blocks a check may link down through to reach a block before the checkpoint. */
export const MAX_BACK_LINK = 4_032
/** Most headers one sync takes; a longer gap continues on the next check. */
const MAX_SYNC = 4_032
/** A sync that found nothing new is not repeated sooner than this. */
const SYNC_INTERVAL_MS = 15_000
const CHUNK = 2016
const DB_NAME = storageRegistry.ltcHeaders.key
const META = 'meta'
const HASHES = 'hashes'

/** The compact encoding of `target` (Bitcoin Core `GetCompact`). */
export function compactFromTarget(target: bigint): number {
  let size = Math.ceil(target.toString(2).length / 8)
  if (target === 0n) size = 0
  let compact = size <= 3 ? Number(target << BigInt(8 * (3 - size))) : Number(target >> BigInt(8 * (size - 3)))
  if (compact & 0x00800000) {
    compact >>>= 8
    size += 1
  }
  return (compact | (size << 24)) >>> 0
}

/**
 * Bits of the first block of a retarget window. Litecoin measures the window
 * from the last block of the window before it (`firstTime`, height - 2017) to
 * the last block of this one (`lastTime`), and halves the target first when it
 * is wide, as Litecoin Core does to keep its 256-bit product from overflowing.
 */
export function nextLtcBits(lastBits: number, lastTime: number, firstTime: number): number {
  const span = Math.min(TARGET_TIMESPAN * 4, Math.max(Math.floor(TARGET_TIMESPAN / 4), lastTime - firstTime))
  let target = targetFromBits(lastBits)
  if (target === null) throw new Error('bad bits')
  const shift = target.toString(2).length > 235
  if (shift) target >>= 1n
  target = (target * BigInt(span)) / BigInt(TARGET_TIMESPAN)
  if (shift) target <<= 1n
  if (target > LTC_POW_LIMIT) target = LTC_POW_LIMIT
  return compactFromTarget(target)
}

/** Expected hashes to find a header at `bits`. */
export function headerWork(bits: number): bigint {
  const target = targetFromBits(bits)
  return target === null ? 0n : (1n << 256n) / (target + 1n)
}

/** `time` is kept from the first header taken on; a chain saved before it was kept has none. */
export type Link = { height: number; hash: string; bits: number; time?: number }

/** What makes a header valid on one chain; the chain object around it is the same for every chain. */
export type HeaderRules = {
  /** The chain's name in errors: "Litecoin". */
  label: string
  /** Log tag: `ltc-headers`. */
  logTag: string
  /** IndexedDB database the hashes live in. */
  dbName: string
  powLimit: bigint
  /** The header's proof-of-work hash, read as a number. */
  powHash(raw: Bytes): bigint
  /** The bits block `height` after `prev` must carry; null when a time it reads is not held. */
  expectedBits(height: number, prev: Link, windowEnd: (height: number) => number | undefined): number | null
  /** Is the time of the block at `height` read by a later retarget? */
  keepsTime(height: number): boolean
  /** A header as the source serves it; by default exactly 80 bytes. Dogecoin's carry their AuxPoW after them. */
  parseHeader?(raw: Bytes): LtcHeader
}

export const LTC_HEADER_RULES: HeaderRules = {
  label: 'Litecoin',
  logTag: 'ltc-headers',
  dbName: DB_NAME,
  powLimit: LTC_POW_LIMIT,
  powHash: scryptPowHash,
  expectedBits(height, prev, windowEnd) {
    if (height % LTC_RETARGET_INTERVAL !== 0) return prev.bits
    const last = windowEnd(height - 1)
    const first = windowEnd(height - 1 - LTC_RETARGET_INTERVAL)
    return last === undefined || first === undefined ? null : nextLtcBits(prev.bits, last, first)
  },
  keepsTime: (height) => height % LTC_RETARGET_INTERVAL === LTC_RETARGET_INTERVAL - 1,
}
type Meta = {
  checkpoint: number
  /** Lowest height with a known hash. */
  base: number
  tip: Link
  /** The last {@link MAX_REORG} links, oldest first: what a reorganization compares and rewinds. */
  recent: Link[]
  /** Times of the last blocks of recent retarget windows, by height. */
  windowEnds: Record<number, number>
}

export type LtcHeaderRefusal = 'chain-link' | 'bits' | 'pow' | 'future' | 'no-window'

/** Does `header`, at `height` after `prev`, follow the chain's header rules? */
export function checkNextHeader(
  header: LtcHeader,
  height: number,
  prev: Link,
  windowEnd: (height: number) => number | undefined,
  nowS: number,
  rules: HeaderRules = LTC_HEADER_RULES,
): LtcHeaderRefusal | null {
  if (header.prevHash !== prev.hash) return 'chain-link'
  const expected = rules.expectedBits(height, prev, windowEnd)
  if (expected === null) return 'no-window'
  if (header.bits !== expected) return 'bits'
  const target = targetFromBits(header.bits)
  if (target === null || target > rules.powLimit || rules.powHash(header.raw) > target) return 'pow'
  if (header.time > nowS + MAX_FUTURE_S) return 'future'
  return null
}

export type LtcBurialAnchor =
  | { kind: 'buried' }
  | { kind: 'shallow'; confirmations: number }
  /** The chain is at least `depth` past `height`, and another block sits there. */
  | { kind: 'off-chain' }
  | { kind: 'unavailable'; detail: string }

export type LtcAnchor = {
  /** Is block `blockHash` at `height` at least `depth` deep on the chain with the most work? */
  check(height: number, blockHash: string, depth: number): Promise<LtcBurialAnchor>
}

export type LtcHeaderStore = {
  readMeta(): Promise<Meta | null>
  readChunk(chunk: number): Promise<string[] | null>
  write(meta: Meta, chunks: ReadonlyMap<number, string[]>): Promise<void>
  clear(): Promise<void>
}

/** A store that lives as long as the chain object: tests, and devices without IndexedDB. */
export function memoryLtcHeaderStore(): LtcHeaderStore {
  let meta: Meta | null = null
  const chunks = new Map<number, string[]>()
  return {
    readMeta: async () => meta,
    readChunk: async (c) => chunks.get(c) ?? null,
    write: async (m, dirty) => {
      meta = m
      for (const [c, list] of dirty) chunks.set(c, [...list])
    },
    clear: async () => {
      meta = null
      chunks.clear()
    },
  }
}

function idbStore(dbName: string, label: string): LtcHeaderStore {
  let opening: Promise<IDBDatabase> | null = null
  const open = () =>
    (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(META)) req.result.createObjectStore(META)
        if (!req.result.objectStoreNames.contains(HASHES)) req.result.createObjectStore(HASHES)
      }
      req.onsuccess = () => {
        req.result.onversionchange = () => {
          req.result.close()
          opening = null
        }
        resolve(req.result)
      }
      req.onerror = () => {
        opening = null
        reject(req.error ?? new Error(`Could not open the ${label} header store`))
      }
    }))
  const run = async <T>(stores: string[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => IDBRequest | void): Promise<T | undefined> => {
    const db = await open()
    return new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(stores, mode)
      const req = body(tx)
      let out: T | undefined
      if (req) req.onsuccess = () => (out = req.result as T)
      tx.oncomplete = () => resolve(out)
      tx.onerror = () => reject(tx.error ?? new Error(`${label} header store failed`))
      tx.onabort = () => reject(tx.error ?? new Error(`${label} header store aborted`))
    })
  }
  return {
    readMeta: async () => (await run<Meta>([META], 'readonly', (tx) => tx.objectStore(META).get('chain'))) ?? null,
    readChunk: async (c) => (await run<string[]>([HASHES], 'readonly', (tx) => tx.objectStore(HASHES).get(c))) ?? null,
    write: async (meta, dirty) => {
      await run([META, HASHES], 'readwrite', (tx) => {
        tx.objectStore(META).put(meta, 'chain')
        for (const [c, list] of dirty) tx.objectStore(HASHES).put(list, c)
      })
    },
    clear: async () => {
      await run([META, HASHES], 'readwrite', (tx) => {
        tx.objectStore(META).clear()
        tx.objectStore(HASHES).clear()
      })
    },
  }
}

function freshMeta(cp: LtcCheckpoint, rules: HeaderRules): Meta {
  const tip = { height: cp.height, hash: cp.hash, bits: cp.bits, time: cp.time }
  // The checkpoint block's own time is a window end too when a later retarget reads it (Dogecoin reads it two blocks on).
  const windowEnds = rules.keepsTime(cp.height) ? { ...cp.windowEnds, [cp.height]: cp.time } : { ...cp.windowEnds }
  return { checkpoint: cp.height, base: cp.height, tip, recent: [tip], windowEnds }
}

export type HeaderChain = LtcAnchor & {
  sync(): Promise<number>
  tipHeight(): Promise<number>
}

/** The parts of a chain source a header chain reads. */
export type HeaderSource = Pick<LtcChain, 'tipHeight' | 'headerPage'> & {
  /** Headers `lo..hi` in one answer, for sources that serve ranges; each still checked by the chain. */
  headerRange?(lo: number, hi: number): Promise<Uint8Array[]>
}

/** A Litecoin header chain over `source` starting at `checkpoint`. */
export function createLtcHeaderChain(opts: { source: HeaderSource; checkpoint?: LtcCheckpoint; store?: LtcHeaderStore; now?: () => number }): HeaderChain {
  return createHeaderChain({ ...opts, rules: LTC_HEADER_RULES, checkpoint: opts.checkpoint ?? LTC_CHECKPOINT })
}

/** A header chain under `rules` over `source`, starting at `checkpoint`. */
export function createHeaderChain(opts: {
  rules: HeaderRules
  source: HeaderSource
  checkpoint: LtcCheckpoint
  store?: LtcHeaderStore
  now?: () => number
}): HeaderChain {
  const { rules } = opts
  const parseHeader = rules.parseHeader ?? parseLtcHeader
  const cp = opts.checkpoint
  const store = opts.store ?? (typeof indexedDB === 'undefined' ? memoryLtcHeaderStore() : idbStore(rules.dbName, rules.label))
  const now = opts.now ?? Date.now
  const chunks = new Map<number, string[]>()
  let meta: Meta | null = null
  let loading: Promise<Meta> | null = null
  let syncing: Promise<number> | null = null
  let idleUntil = 0

  const load = () =>
    (loading ??= (async () => {
      const saved = await store.readMeta().catch(() => null)
      // A newer shipped checkpoint replaces a chain that fell behind it.
      if (saved && saved.checkpoint === cp.height && saved.tip.height >= cp.height) meta = saved
      else {
        if (saved) await store.clear().catch(() => {})
        meta = freshMeta(cp, rules)
        setHash(cp.height, cp.hash)
      }
      return meta
    })())

  const chunkOf = async (c: number): Promise<string[]> => {
    let list = chunks.get(c)
    if (!list) {
      list = (await store.readChunk(c).catch(() => null)) ?? new Array<string>(CHUNK).fill('')
      chunks.set(c, list)
    }
    return list
  }
  const dirty = new Set<number>()
  function setHash(height: number, hash: string) {
    const c = Math.floor(height / CHUNK)
    const list = chunks.get(c) ?? new Array<string>(CHUNK).fill('')
    list[height % CHUNK] = hash
    chunks.set(c, list)
    dirty.add(c)
  }
  const hashAt = async (height: number) => (await chunkOf(Math.floor(height / CHUNK)))[height % CHUNK] || null

  async function persist(m: Meta) {
    const out = new Map<number, string[]>()
    for (const c of dirty) out.set(c, chunks.get(c)!)
    dirty.clear()
    await store.write(m, out).catch((err) => console.warn(`[${rules.logTag}] save failed — ${err instanceof Error ? err.message : String(err)}`))
  }

  /** Headers `lo..hi` ascending, from pages of ten. */
  async function fetchRange(lo: number, hi: number): Promise<Array<{ height: number; header: LtcHeader }>> {
    if (opts.source.headerRange) {
      const raws = await opts.source.headerRange(lo, hi)
      if (raws.length !== hi - lo + 1) throw new Error(`the source returned ${raws.length} of ${hi - lo + 1} headers`)
      return raws.map((raw, i) => ({ height: lo + i, header: parseHeader(raw) }))
    }
    const byHeight = new Map<number, LtcHeader>()
    for (let top = Math.min(hi, lo + 9); ; top = Math.min(hi, top + 10)) {
      const page = await opts.source.headerPage(top)
      for (const row of page) {
        if (row.height >= lo && row.height <= hi && row.height > top - 10 && !byHeight.has(row.height)) byHeight.set(row.height, parseHeader(row.header))
      }
      if (top >= hi) break
    }
    const out = [...byHeight].map(([height, header]) => ({ height, header })).sort((a, b) => a.height - b.height)
    for (let i = 0; i < out.length; i++) if (out[i]!.height !== lo + i) throw new Error(`the explorer skipped block ${lo + i}`)
    if (out.length !== hi - lo + 1) throw new Error(`the explorer returned ${out.length} of ${hi - lo + 1} headers`)
    return out
  }

  /** Take headers after `from` (a link this chain holds); returns the links taken. */
  function validate(from: Link, rows: Array<{ height: number; header: LtcHeader }>, ends: Record<number, number>): Link[] {
    const links: Link[] = []
    let prev = from
    const nowS = Math.floor(now() / 1000)
    for (const { height, header } of rows) {
      const refusal = checkNextHeader(header, height, prev, (h) => ends[h], nowS, rules)
      if (refusal) throw new Error(`${rules.label} header ${height} refused: ${refusal}`)
      if (rules.keepsTime(height)) ends[height] = header.time
      prev = { height, hash: header.hash, bits: header.bits, time: header.time }
      links.push(prev)
    }
    return links
  }

  function commit(m: Meta, links: Link[], ends: Record<number, number>) {
    for (const link of links) setHash(link.height, link.hash)
    const keep = Object.keys(ends).map(Number).sort((a, b) => b - a).slice(0, 3)
    m.windowEnds = Object.fromEntries(keep.map((h) => [h, ends[h]!]))
    m.recent = [...m.recent.filter((r) => r.height < (links[0]?.height ?? Infinity)), ...links].slice(-MAX_REORG)
    m.tip = m.recent[m.recent.length - 1]!
  }

  async function syncOnce(): Promise<number> {
    const m = await load()
    const sourceTip = await opts.source.tipHeight()
    if (sourceTip <= m.tip.height) return m.tip.height
    const hi = Math.min(sourceTip, m.tip.height + MAX_SYNC)
    let rows = await fetchRange(m.tip.height + 1, Math.min(hi, m.tip.height + 10))
    let from = m.tip
    if (rows[0]!.header.prevHash !== m.tip.hash) {
      // Reorganized: find where the explorer's chain meets ours, then keep the branch with more work.
      let fork: Link | null = null
      const branch: Array<{ height: number; header: LtcHeader }> = []
      for (let i = m.recent.length - 2; i >= 0 && !fork; i--) {
        const link = m.recent[i]!
        const [row] = await fetchRange(link.height + 1, link.height + 1)
        branch.unshift(row!)
        if (row!.header.prevHash === link.hash) fork = link
      }
      if (!fork) throw new Error(`the explorer's chain leaves this one more than ${MAX_REORG} blocks back`)
      rows = [...branch, ...(await fetchRange(m.tip.height + 1, hi))]
      const ends = { ...m.windowEnds }
      for (const h of Object.keys(ends).map(Number)) if (h > fork.height) delete ends[h]
      // Every-block retargets (Dogecoin) read times older than the kept window ends; the recent links hold them.
      for (const link of m.recent) {
        if (link.height <= fork.height && link.time !== undefined && rules.keepsTime(link.height)) ends[link.height] ??= link.time
      }
      const links = validate(fork, rows, ends)
      const theirs = links.reduce((w, l) => w + headerWork(l.bits), 0n)
      const ours = m.recent.filter((l) => l.height > fork!.height).reduce((w, l) => w + headerWork(l.bits), 0n)
      if (theirs <= ours) throw new Error('the explorer serves a branch with less work than this chain')
      console.warn(`[${rules.logTag}] reorganized from ${fork.height} (${m.tip.height - fork.height} blocks)`)
      commit(m, links, ends)
      await persist(m)
      return m.tip.height
    }
    const startedAt = Date.now()
    const ends = { ...m.windowEnds }
    for (;;) {
      const links = validate(from, rows, ends)
      commit(m, links, ends)
      from = m.tip
      if (from.height >= hi) break
      rows = await fetchRange(from.height + 1, Math.min(hi, from.height + (opts.source.headerRange ? 2016 : 100)))
    }
    await persist(m)
    const ms = Date.now() - startedAt
    if (ms > 250) console.info(`[${rules.logTag}] sync done ${ms}ms (to ${m.tip.height})`)
    return m.tip.height
  }

  function sync(): Promise<number> {
    if (syncing) return syncing
    syncing = syncOnce().finally(() => {
      syncing = null
    })
    return syncing
  }

  /** The hash at `height` below the chain's base, linking down to the base by hash alone. */
  async function linkDown(m: Meta, height: number): Promise<string | null> {
    if (m.base - height > MAX_BACK_LINK) return null
    const rows = await fetchRange(height, m.base)
    const baseHash = await hashAt(m.base)
    if (rows[rows.length - 1]!.header.hash !== baseHash) throw new Error(`the explorer's block ${m.base} is not this chain's`)
    for (let i = rows.length - 1; i > 0; i--) {
      if (rows[i]!.header.prevHash !== rows[i - 1]!.header.hash) throw new Error(`block ${rows[i]!.height} does not build on the block below it`)
    }
    for (const row of rows) setHash(row.height, row.header.hash)
    m.base = height
    await persist(m)
    return rows[0]!.header.hash
  }

  return {
    sync,
    async tipHeight() {
      return (await load()).tip.height
    },
    async check(height, blockHash, depth) {
      const m = await load()
      const want = height + depth - 1
      try {
        if (m.tip.height < want && now() >= idleUntil) {
          const before = m.tip.height
          await sync()
          if (m.tip.height === before) idleUntil = now() + SYNC_INTERVAL_MS
        }
        if (height > m.tip.height) return { kind: 'shallow', confirmations: 0 }
        const known = height >= m.base ? await hashAt(height) : await linkDown(m, height)
        if (!known) return { kind: 'unavailable', detail: `block ${height} is more than ${MAX_BACK_LINK} blocks before this wallet's ${rules.label} checkpoint` }
        if (known !== blockHash.toLowerCase()) return m.tip.height >= want ? { kind: 'off-chain' } : { kind: 'shallow', confirmations: 0 }
        if (m.tip.height < want) return { kind: 'shallow', confirmations: m.tip.height - height + 1 }
        return { kind: 'buried' }
      } catch (err) {
        return { kind: 'unavailable', detail: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}

let anchor: LtcAnchor | null = null

/** The wallet's Litecoin header chain, made on first use. */
export function getLtcAnchor(): LtcAnchor {
  return (anchor ??= createLtcHeaderChain({ source: defaultLtcChain() }))
}

/** Tests swap the anchor; null restores the real chain. */
export function setLtcAnchorForTest(next: LtcAnchor | null): void {
  anchor = next
}
