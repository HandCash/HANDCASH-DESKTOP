/**
 * Session cache for `getBeefForTxid`.
 *
 * Collectable signing asks for the same tip (and often the same latch / origin /
 * proof) several times in one send: input BEEF, provenance rebuild, genesis
 * origin script, settle rebuild. Each round trip is a storage-provider call, and
 * a mined transaction body never changes, so paying for it more than once is
 * pure latency. Hits are held for the life of a sync/send window; misses are not
 * cached, so a transient outage does not pin a wrong answer.
 */
import { Beef } from '@bsv/sdk'
import type { ActiveWallet } from './session'

const TTL_MS = 10 * 60_000
const MAX = 200
/** Per-txid fetch — indexer / WoC must not wedge mint or send forever. */
const BEEF_FETCH_TIMEOUT_MS = 8_000
/** Whole hydrate pass across missing parents. */
const HYDRATE_DEADLINE_MS = 12_000

const cache = new Map<string, { at: number; binary: number[] }>()
const inflight = new Map<string, Promise<Beef>>()

const keyOf = (txid: string): string => txid.trim().toLowerCase()

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

export function rememberBeefBinary(txid: string, binary: number[]): void {
  try {
    rememberBeef(txid, Beef.fromBinary(binary))
  } catch {
    // Ignore malformed binaries — the next fetch will recover.
  }
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

export async function getBeefForTxidCached(
  wallet: ActiveWallet,
  txid: string,
): Promise<Beef> {
  const key = keyOf(txid)
  const cached = read(txid)
  if (cached) return cached

  const pending = inflight.get(key)
  if (pending) return pending

  const request = (async () => {
    const local = await getBeefFromLocalStorage(wallet, txid)
    if (local) {
      write(txid, local)
      return local
    }

    if (!wallet.services?.getBeefForTxid) {
      throw new Error(
        'Cannot prove the collectable input offline. Try again when connected.',
      )
    }

    const beef = await withTimeout(
      wallet.services.getBeefForTxid(txid),
      BEEF_FETCH_TIMEOUT_MS,
      `indexer BEEF ${txid.slice(0, 8)}`,
    )
    write(txid, beef)
    return beef
  })().finally(() => {
    inflight.delete(key)
  })

  inflight.set(key, request)
  return request
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
}
