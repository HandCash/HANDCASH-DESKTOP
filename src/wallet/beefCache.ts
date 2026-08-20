/**
 * Session cache for `getBeefForTxid`.
 *
 * Collectable signing asks for the same tip (and often the same latch / origin /
 * proof) several times in one send: input BEEF, provenance rebuild, genesis
 * origin script, settle rebuild. Each round trip is a storage-provider call, and
 * a mined transaction body never changes, so paying for it more than once is
 * pure latency. Hits are held for the life of a sync/send window; misses are not
 * cached, so a transient outage does not pin a wrong answer.
 *
 * Wallet-created settles (self-send NFT) also persist Atomic BEEF durably —
 * delayed broadcast is not yet in the indexer, and toolbox storage may not
 * expose `getBeefForTransaction` until proven.
 */
import { Beef, Utils } from '@bsv/sdk'
import type { ActiveWallet } from './session'
import { durableGetItem, durableRemoveItem, durableSetItem } from './durableStorage'

export type GetBeefOpts = {
  /**
   * Already-broadcast payment ingest: wrap `getRawTx` (Bitails) as BEEF.
   * Indexer `getBeefForTxid` often exceeds 8s; remittance does not need merkle.
   */
  allowUnprovenRawTx?: boolean
}

export type AtomicBeefPurpose = 'default' | 'inboundItemHint'

const TTL_MS = 10 * 60_000
const MAX = 200
/** Per-txid fetch — indexer / WoC must not wedge mint or send forever. */
const BEEF_FETCH_TIMEOUT_MS = 8_000
/** Whole hydrate pass across missing parents. */
const HYDRATE_DEADLINE_MS = 12_000

const cache = new Map<string, { at: number; binary: number[] }>()
const inflight = new Map<string, Promise<Beef>>()
/** One AtomicBEEF build per txid — hydrate must not fan out across tip polls. */
const atomicInflight = new Map<string, Promise<number[]>>()
/** Failed AtomicBEEF builds: do not re-hammer indexer until this epoch. */
const atomicFailUntil = new Map<string, number>()

const ATOMIC_FAIL_BACKOFF_MS = 10 * 60_000
const ATOMIC_NOT_ON_CHAIN_BACKOFF_MS = 60 * 60_000
/**
 * A durable, un-ACK'd inbox hint can arrive just before the sender's silent
 * postBeef. That race is expected, not an indexer outage: retry soon instead of
 * suppressing every five-second inbox poll for ten minutes.
 */
const INBOUND_ITEM_HINT_BACKOFF_MS = 10_000

const DURABLE_PREFIX = 'handcash.createdBeef.'
const DURABLE_INDEX_KEY = 'handcash.createdBeef.index'
const DURABLE_MAX = 16

const keyOf = (txid: string): string => txid.trim().toLowerCase()

function persistDurableBeef(txid: string, binary: number[]): void {
  try {
    const key = keyOf(txid)
    if (!/^[0-9a-f]{64}$/.test(key) || binary.length === 0) return
    durableSetItem(DURABLE_PREFIX + key, Utils.toBase64(binary))
    let index: string[] = []
    try {
      const raw = durableGetItem(DURABLE_INDEX_KEY)
      if (raw) index = JSON.parse(raw) as string[]
    } catch {
      index = []
    }
    if (!Array.isArray(index)) index = []
    const next = [key, ...index.filter((id) => id !== key)].slice(0, DURABLE_MAX)
    durableSetItem(DURABLE_INDEX_KEY, JSON.stringify(next))
    for (const old of index) {
      if (!next.includes(old)) durableRemoveItem(DURABLE_PREFIX + old)
    }
  } catch {
    // Quota / private mode — session cache still covers this send window.
  }
}

function readDurableBeef(txid: string): Beef | null {
  try {
    const b64 = durableGetItem(DURABLE_PREFIX + keyOf(txid))
    if (!b64) return null
    const beef = Beef.fromBinary(Utils.toArray(b64, 'base64'))
    if (!beef.findTxid(keyOf(txid))?.tx) return null
    for (const btx of beef.txs) {
      const id = String(btx.txid ?? '').toLowerCase()
      if (/^[0-9a-f]{64}$/.test(id) && btx.tx) write(id, beef)
    }
    return beef
  } catch {
    return null
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  // If we time out first, swallow a later settle so it is not an unhandled rejection.
  void work.then(
    () => undefined,
    () => undefined,
  )
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(`${label} timed out after ${ms}ms`))
      }, ms)
      work.then(
        (value) => {
          if (settled) return
          settled = true
          resolve(value)
        },
        (err) => {
          if (settled) return
          settled = true
          reject(err)
        },
      )
    })
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function read(txid: string): Beef | null {
  const hit = cache.get(keyOf(txid))
  if (!hit) return null
  if (Date.now() - hit.at >= TTL_MS) {
    cache.delete(keyOf(txid))
    return null
  }
  return Beef.fromBinary(hit.binary)
}

function write(txid: string, beef: Beef): void {
  if (cache.size >= MAX) {
    const oldest = cache.keys().next().value
    if (oldest != null) cache.delete(oldest)
  }
  cache.set(keyOf(txid), { at: Date.now(), binary: beef.toBinary() })
}

/** Remember a BEEF that was already fetched or built elsewhere in this send. */
export function rememberBeef(txid: string, beef: Beef): void {
  if (!txid || !beef.findTxid(keyOf(txid))?.tx) return
  write(txid, beef)
}

/**
 * Cache every full tx in an Atomic BEEF (tip + latch share a settle tx).
 * When `persistTxid` is set, also keep that settle body across restarts.
 */
export function rememberBeefTree(binary: number[] | undefined | null, persistTxid?: string): void {
  if (!binary?.length) return
  try {
    const beef = Beef.fromBinary(binary)
    for (const btx of beef.txs) {
      const id = String(btx.txid ?? '').toLowerCase()
      if (/^[0-9a-f]{64}$/.test(id) && btx.tx) write(id, beef)
    }
    const persist = persistTxid?.trim().toLowerCase()
    if (persist && /^[0-9a-f]{64}$/.test(persist) && beef.findTxid(persist)?.tx) {
      persistDurableBeef(persist, binary)
    }
  } catch {
    // Ignore malformed binaries — the next fetch will recover.
  }
}

export function rememberBeefBinary(txid: string, binary: number[]): void {
  rememberBeefTree(binary, txid)
}

/**
 * Prefer local proven_tx / proven_tx_req before hitting WhatsOnChain.
 * When the indexer is unreachable this is the only path that still works for
 * tips the wallet itself created (fresh deploy → mint).
 */
async function getBeefFromLocalStorage(
  wallet: ActiveWallet,
  txid: string,
): Promise<Beef | null> {
  try {
    const storageApi = wallet.wallet.storage
    if (!storageApi?.isActiveStorageProvider?.()) return null
    if (typeof storageApi.runAsStorageProvider !== 'function') return null
    return await withTimeout(
      storageApi.runAsStorageProvider(async (storage) => {
        const beef = await storage.getBeefForTransaction(txid, {
          ignoreServices: true,
        })
        return beef.findTxid(keyOf(txid))?.tx ? beef : null
      }),
      BEEF_FETCH_TIMEOUT_MS,
      `storage BEEF ${txid.slice(0, 8)}`,
    )
  } catch {
    return null
  }
}

async function fetchBitailsRawTx(txid: string): Promise<number[] | null> {
  try {
    const res = await withTimeout(
      fetch(`https://api.bitails.io/download/tx/${txid}/hex`, {
        headers: { Accept: 'text/plain' },
      }),
      12_000,
      `bitails hex ${txid.slice(0, 8)}`,
    )
    if (!res.ok) return null
    const hex = (await res.text()).trim()
    if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null
    return Utils.toArray(hex, 'hex')
  } catch {
    return null
  }
}

/**
 * Proof-carrying BEEF straight from WhatsOnChain.
 *
 * The toolbox `getBeefForTxid` composes rawtx + merkle path across providers and
 * routinely exceeds 8s on deep ordinal lineages (Pixel Foxes transfers), while
 * GorillaPool 404s the BEEF for those same transfer txids. WhatsOnChain's `/beef`
 * returns the whole thing — subject tx plus its BUMP — in a few hundred ms, so a
 * lineage walk that would otherwise time out every hop can actually complete.
 *
 * Unlike {@link getBeefFromRawTx} this is a *proven* source (it carries the
 * merkle proof), so it is safe for the BRC-150 proof path, not just raw ingest.
 */
async function fetchWocProvenBeef(
  txid: string,
  chain: ActiveWallet['chain'],
): Promise<Beef | null> {
  const key = keyOf(txid)
  if (!/^[0-9a-f]{64}$/.test(key)) return null
  const base =
    chain === 'test'
      ? 'https://api.whatsonchain.com/v1/bsv/test'
      : 'https://api.whatsonchain.com/v1/bsv/main'
  try {
    const res = await withTimeout(
      fetch(`${base}/tx/${key}/beef`, { headers: { Accept: 'text/plain' } }),
      BEEF_FETCH_TIMEOUT_MS,
      `woc beef ${key.slice(0, 8)}`,
    )
    if (!res.ok) return null
    const body = (await res.text()).trim()
    const bytes = /^[0-9a-f]+$/i.test(body)
      ? Utils.toArray(body, 'hex')
      : Utils.toArray(body, 'base64')
    if (!bytes.length) return null
    const beef = Beef.fromBinary(bytes)
    // Must carry the subject tx *and* its proof — a bare rawtx here would defeat
    // the point of preferring this over the raw fallback.
    const entry = beef.findTxid(key)
    if (!entry?.tx || entry.isTxidOnly) return null
    return beef
  } catch {
    return null
  }
}

async function getBeefFromRawTx(
  wallet: ActiveWallet,
  txid: string,
): Promise<Beef | null> {
  const key = keyOf(txid)
  let raw: number[] | undefined
  try {
    const getRawTx = wallet.services?.getRawTx
    if (typeof getRawTx === 'function') {
      const result = await withTimeout(
        getRawTx(key),
        12_000,
        `rawTx ${key.slice(0, 8)}`,
      )
      if (result?.rawTx?.length) raw = Array.from(result.rawTx)
    }
  } catch {
    /* try Bitails next */
  }
  if (!raw?.length) {
    const hex = await fetchBitailsRawTx(key)
    if (hex?.length) raw = hex
  }
  if (!raw?.length) return null
  try {
    const beef = new Beef()
    beef.mergeRawTx(raw)
    return beef.findTxid(key)?.tx ? beef : null
  } catch {
    return null
  }
}

function beefHasSubjectTx(beef: Beef, txid: string): boolean {
  return Boolean(beef.findTxid(keyOf(txid))?.tx)
}

/** True when AtomicBEEF for this subject is structurally ready for internalize. */
export function beefIsAtomicReady(beef: Beef, txid: string): boolean {
  const key = keyOf(txid)
  if (!beefHasSubjectTx(beef, key)) return false
  try {
    const atomic = beef.toBinaryAtomic(key)
    const check = Beef.fromBinary(atomic)
    if (!beefHasSubjectTx(check, key)) return false
    // Soft-latch settles have inputs — raw tip-only (0 parents, 0 bumps) fails
    // toolbox internalize with "must be valid AtomicBEEF".
    return check.verifyValid(false).valid
  } catch {
    return false
  }
}

/**
 * Fetch several transactions at once so a later sequential reader finds them.
 *
 * A lineage walk discovers each hop only after fetching the one before it, so it
 * can never overlap its own round trips. Once the path is already known there is
 * nothing to discover, and the same walk replayed over a warm cache costs one
 * batch instead of one trip per hop. Failures are ignored — this decides only
 * how long the walk takes, never whether it succeeds.
 */
export async function warmBeefCache(
  wallet: ActiveWallet,
  txids: string[],
): Promise<void> {
  const cold = [...new Set(txids.map(keyOf))].filter((txid) => !read(txid))
  await Promise.allSettled(cold.map((txid) => getBeefForTxidCached(wallet, txid)))
}

export async function getBeefForTxidCached(
  wallet: ActiveWallet,
  txid: string,
  opts?: GetBeefOpts,
): Promise<Beef> {
  const key = keyOf(txid)
  const cached = read(txid)
  if (cached) {
    // Tip-only raw must not stick in cache — soft-latch internalize needs parents.
    if (incompleteProofTxids(cached).length === 0) return cached
    cache.delete(key)
  }

  const durable = readDurableBeef(txid)
  if (durable) return durable

  const pending = inflight.get(key)
  if (pending) return pending

  const request = (async () => {
    const local = await getBeefFromLocalStorage(wallet, txid)
    if (local) {
      write(txid, local)
      return local
    }

    // Prefer indexer / proven BEEF before raw. Raw tip-only used to run first,
    // get cached, then soft-latch internalize failed forever (0 BUMPS / missing
    // parents) — Desktop could not receive mobile→desktop item settles.
    let indexerErr: unknown = null
    if (wallet.services?.getBeefForTxid) {
      try {
        const beef = await withTimeout(
          wallet.services.getBeefForTxid(txid),
          BEEF_FETCH_TIMEOUT_MS,
          `indexer BEEF ${txid.slice(0, 8)}`,
        )
        if (beefHasSubjectTx(beef, key)) {
          write(txid, beef)
          return beef
        }
      } catch (err) {
        indexerErr = err
        console.warn('[beef] indexer fetch failed; trying WhatsOnChain', key.slice(0, 8), err)
      }
    } else if (!opts?.allowUnprovenRawTx) {
      throw new Error(
        'Cannot prove the collectable input offline. Try again when connected.',
      )
    }

    // Proof-carrying fallback. Runs even without `allowUnprovenRawTx` because it
    // returns a real merkle proof — this is what lets a BRC-150 lineage walk
    // finish when the toolbox service times out or GorillaPool 404s the BEEF.
    const wocProven = await fetchWocProvenBeef(key, wallet.chain)
    if (wocProven) {
      write(txid, wocProven)
      return wocProven
    }
    if (indexerErr && !opts?.allowUnprovenRawTx) throw indexerErr

    if (opts?.allowUnprovenRawTx) {
      const fromRaw = await getBeefFromRawTx(wallet, txid)
      if (fromRaw) {
        const hydratedBin = await hydrateInputBeef(wallet, fromRaw)
        if (hydratedBin?.length) {
          const hydrated = Beef.fromBinary(hydratedBin)
          if (beefHasSubjectTx(hydrated, key)) {
            write(txid, hydrated)
            return hydrated
          }
        }
        // Do not cache tip-only raw — it poisons later AtomicBEEF internalize.
        return fromRaw
      }
    }

    throw new Error(
      'Cannot prove the collectable input offline. Try again when connected.',
    )
  })().finally(() => {
    inflight.delete(key)
  })

  inflight.set(key, request)
  return request
}

/**
 * AtomicBEEF bytes safe for `internalizeAction` (soft-latch tip+latch / peer
 * item settle). Hydrates parents when the indexer returns a thin body.
 *
 * Dedupes concurrent callers and backs off after failures so a tip poll cannot
 * spawn dozens of parallel 8s indexer hydrates (Desktop ingest loop).
 */
export async function getAtomicBeefBinaryForTxid(
  wallet: ActiveWallet,
  txid: string,
  opts?: { purpose?: AtomicBeefPurpose },
): Promise<number[]> {
  const key = keyOf(txid)
  const until = atomicFailUntil.get(key)
  if (until != null && Date.now() < until) {
    const secs = Math.ceil((until - Date.now()) / 1000)
    throw new Error(
      `AtomicBEEF backoff ${key.slice(0, 12)}… (${secs}s) — indexer miss or not on chain`,
    )
  }

  const pending = atomicInflight.get(key)
  if (pending) return pending

  const request = (async () => {
    try {
      const beef = await getBeefForTxidCached(wallet, key, {
        allowUnprovenRawTx: true,
      })
      if (beefIsAtomicReady(beef, key)) {
        atomicFailUntil.delete(key)
        return Array.from(beef.toBinaryAtomic(key))
      }
      const hydratedBin = await hydrateInputBeef(wallet, beef)
      if (hydratedBin?.length) {
        const hydrated = Beef.fromBinary(hydratedBin)
        if (beefIsAtomicReady(hydrated, key)) {
          write(key, hydrated)
          atomicFailUntil.delete(key)
          return Array.from(hydrated.toBinaryAtomic(key))
        }
      }
      const fromRaw = await getBeefFromRawTx(wallet, key)
      if (fromRaw) {
        const merged = beef.clone()
        merged.mergeBeef(fromRaw.toBinary())
        const again = await hydrateInputBeef(wallet, merged)
        if (again?.length) {
          const ready = Beef.fromBinary(again)
          if (beefIsAtomicReady(ready, key)) {
            write(key, ready)
            atomicFailUntil.delete(key)
            return Array.from(ready.toBinaryAtomic(key))
          }
        }
      }
      throw new Error(
        `Could not build AtomicBEEF for ${key.slice(0, 12)}… — wait for the indexer, then refresh.`,
      )
    } catch (err) {
      noteAtomicBeefFailure(key, err, opts)
      throw err
    }
  })().finally(() => {
    atomicInflight.delete(key)
  })

  atomicInflight.set(key, request)
  return request
}

export function noteAtomicBeefFailure(
  txid: string,
  err: unknown,
  opts?: { purpose?: AtomicBeefPurpose },
): void {
  const key = keyOf(txid)
  if (!key) return
  const msg = err instanceof Error ? err.message : String(err)
  if (/AtomicBEEF backoff/i.test(msg)) return
  const ms =
    opts?.purpose === 'inboundItemHint'
      ? INBOUND_ITEM_HINT_BACKOFF_MS
      : /valid transaction on chain|not (?:found|on[ -]?chain)|offline/i.test(
            msg,
          )
        ? ATOMIC_NOT_ON_CHAIN_BACKOFF_MS
        : ATOMIC_FAIL_BACKOFF_MS
  const prev = atomicFailUntil.get(key) ?? 0
  const next = Date.now() + ms
  if (next > prev) atomicFailUntil.set(key, next)
}

export function isAtomicBeefInBackoff(txid: string, now = Date.now()): boolean {
  const until = atomicFailUntil.get(keyOf(txid))
  return until != null && now < until
}

/**
 * Txids that are only stubs or missing as parents — not broadcast-safe.
 *
 * processAction verifies the merged BEEF **without** allowTxidOnly. A txidOnly
 * stub also blocks mergeInputsIntoBeef hydration (`findTxid != null` → skip),
 * which surfaces as "merged Beef failed validation."
 */
export function incompleteProofTxids(beef: Beef): string[] {
  const need = new Set<string>()
  for (const btx of beef.txs) {
    const id = keyOf(btx.txid)
    if (btx.isTxidOnly || !btx.tx) {
      need.add(id)
      continue
    }
    for (const parent of btx.inputTxids ?? []) {
      const pid = keyOf(parent)
      if (!pid) continue
      const found = beef.findTxid(pid)
      if (!found || found.isTxidOnly || !found.tx) need.add(pid)
    }
  }
  const sorted = beef.sortTxs()
  for (const parent of sorted.missingInputs ?? []) {
    need.add(keyOf(String(parent)))
  }
  return [...need].filter(Boolean)
}

function roundTripBroadcastSafe(bin: number[]): number[] | undefined {
  try {
    const check = Beef.fromBinary(bin)
    check.atomicTxid = undefined
    // No allowTxidOnly — must match processAction's verify(chainTracker).
    return check.verifyValid(false).valid ? bin : undefined
  } catch {
    return undefined
  }
}

/**
 * Ensure inputBEEF has raw tip bodies **and** full parent proofs (no txidOnly).
 * Safe for createAction trustSelf verify and for processAction broadcast verify.
 *
 * Bounded: never waits longer than {@link HYDRATE_DEADLINE_MS} total, and each
 * parent fetch is capped by {@link BEEF_FETCH_TIMEOUT_MS}.
 */
export async function hydrateInputBeef(
  wallet: ActiveWallet,
  beef: Beef,
): Promise<number[] | undefined> {
  const deadline = Date.now() + HYDRATE_DEADLINE_MS
  try {
    let work = beef.clone()
    work.atomicTxid = undefined

    for (let pass = 0; pass < 12; pass++) {
      const ok = roundTripBroadcastSafe(work.toBinary())
      if (ok) return ok

      if (Date.now() >= deadline) {
        console.warn('[beef] hydrate deadline exceeded')
        break
      }

      const need = incompleteProofTxids(work)
      if (need.length === 0) break

      let added = false
      for (const txid of need) {
        if (Date.now() >= deadline) break
        try {
          const proved = await getBeefForTxidCached(wallet, txid)
          // mergeBeef upgrades an existing txidOnly entry when raw+proof arrives.
          work.mergeBeef(proved.toBinary())
          work.atomicTxid = undefined
          if (work.findTxid(txid)?.tx && !work.findTxid(txid)?.isTxidOnly) {
            added = true
          }
        } catch (err) {
          console.warn('[beef] hydrate proof failed', txid, err)
        }
      }
      if (!added) break
    }

    work.atomicTxid = undefined
    return roundTripBroadcastSafe(work.toBinary())
  } catch {
    return undefined
  }
}

/**
 * @deprecated Prefer hydrateInputBeef — txidOnly stubs break processAction verify.
 * Kept for sync call sites that only need structural trustSelf checks in tests.
 */
export function asTrustSelfInputBeef(beef: Beef): number[] | undefined {
  try {
    const work = beef.clone()
    work.atomicTxid = undefined
    // Do not invent txidOnly parents — that caused "merged Beef failed validation".
    return roundTripBroadcastSafe(work.toBinary())
      ?? (work.verifyValid(true).valid
        ? (() => {
            const bin = work.toBinary()
            const check = Beef.fromBinary(bin)
            check.atomicTxid = undefined
            return check.verifyValid(true).valid ? bin : undefined
          })()
        : undefined)
  } catch {
    return undefined
  }
}

/**
 * Merge BEEFs for every unique spend txid, fetching in parallel and sharing the
 * session cache with provenance / hardened settle / origin script lookups.
 */
export async function buildMergedInputBeef(
  wallet: ActiveWallet,
  outpoints: string[],
  normalizeOutpoint: (op: string) => string,
): Promise<number[]> {
  const txids = [
    ...new Set(
      outpoints
        .map((op) => normalizeOutpoint(op).split('.')[0]?.toLowerCase())
        .filter((txid): txid is string => !!txid),
    ),
  ]

  const fetched = await Promise.all(
    txids.map(async (txid) => {
      try {
        return await getBeefForTxidCached(wallet, txid)
      } catch (err) {
        console.warn('[beef] inputBEEF fetch failed', txid, err)
        return null
      }
    }),
  )

  const merged = new Beef()
  for (const beef of fetched) {
    if (beef) merged.mergeBeef(beef.toBinary())
  }

  const missing = txids.filter((txid) => merged.findTxid(txid)?.tx == null)
  if (missing.length > 0) {
    throw new Error(
      'Could not load the transaction that holds this collectable. Refresh, then send again.',
    )
  }

  const hydrated = await hydrateInputBeef(wallet, merged)
  if (hydrated) return hydrated
  return merged.toBinary()
}

export function resetBeefCacheForTests(): void {
  cache.clear()
  inflight.clear()
  atomicInflight.clear()
  atomicFailUntil.clear()
}

/** Drop persisted settle BEEFs (test isolation). */
export function resetDurableBeefForTests(): void {
  try {
    const raw = durableGetItem(DURABLE_INDEX_KEY)
    const index = raw ? (JSON.parse(raw) as string[]) : []
    if (Array.isArray(index)) {
      for (const id of index) durableRemoveItem(DURABLE_PREFIX + id)
    }
  } catch {
    /* ignore */
  }
  durableRemoveItem(DURABLE_INDEX_KEY)
}
