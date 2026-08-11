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

const cache = new Map<string, { at: number; binary: number[] }>()
const inflight = new Map<string, Promise<Beef>>()

const keyOf = (txid: string): string => txid.trim().toLowerCase()

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

export async function getBeefForTxidCached(
  wallet: ActiveWallet,
  txid: string,
): Promise<Beef> {
  const key = keyOf(txid)
  const cached = read(txid)
  if (cached) return cached

  const pending = inflight.get(key)
  if (pending) return pending

  if (!wallet.services?.getBeefForTxid) {
    throw new Error('Cannot prove the collectable input offline. Try again when connected.')
  }

  const request = wallet.services
    .getBeefForTxid(txid)
    .then((beef) => {
      write(txid, beef)
      return beef
    })
    .finally(() => {
      inflight.delete(key)
    })
  inflight.set(key, request)
  return request
}

/**
 * Shape a BEEF so createAction with `trustSelf:'known'` accepts it AND so
 * signable user inputs can resolve `sourceTransaction` from raw tip bodies.
 *
 * Tip-only / AtomicBEEF wraps often fail `verifyValid(true)` because parents
 * are missing. Patch those parents as txidOnly — the toolbox vouchers them via
 * storage when trustSelf is on. Never strip the tip raw txs: omitting inputBEEF
 * surfaces as "Every signableTransaction input must have a sourceTransaction".
 */
export function asTrustSelfInputBeef(beef: Beef): number[] | undefined {
  try {
    let work = beef.clone()
    work.atomicTxid = undefined

    for (let pass = 0; pass < 12; pass++) {
      if (work.verifyValid(true).valid) {
        const bin = work.toBinary()
        const check = Beef.fromBinary(bin)
        check.atomicTxid = undefined
        if (check.verifyValid(true).valid) return bin
        work = check
        continue
      }

      let added = false
      for (const btx of [...work.txs]) {
        if (btx.isTxidOnly || !btx.tx) continue
        for (const parent of btx.inputTxids ?? []) {
          const id = parent.trim().toLowerCase()
          if (!id || work.findTxid(id)) continue
          work.mergeTxidOnly(id)
          added = true
        }
      }
      const sorted = work.sortTxs()
      for (const parent of sorted.missingInputs ?? []) {
        const id = String(parent).trim().toLowerCase()
        if (!id || work.findTxid(id)) continue
        work.mergeTxidOnly(id)
        added = true
      }
      if (!added) break
    }

    work.atomicTxid = undefined
    if (!work.verifyValid(true).valid) return undefined
    const bin = work.toBinary()
    const check = Beef.fromBinary(bin)
    check.atomicTxid = undefined
    return check.verifyValid(true).valid ? bin : undefined
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

  return asTrustSelfInputBeef(merged) ?? merged.toBinary()
}

export function resetBeefCacheForTests(): void {
  cache.clear()
  inflight.clear()
}
