/**
 * Builds the input BEEF for a legacy P2PKH sweep.
 *
 * This is cash, not an item: the address scanner already showed the UTXO
 * (mempool or mined). Fetch the deposit body and stop. Do not walk parent
 * ancestry and do not wait for a merkle path — ARC / mempool accept is enough.
 *
 * The toolbox still calls `Beef.verify` (SPV) inside `createAction`. That is
 * the wrong gate for this path. {@link withVisibleOnChainBeef} lets the sweep
 * proceed when the subject tx body is present.
 */
import { Beef, Transaction, type BEEF } from '@bsv/sdk'
import type { Services } from '@bsv/wallet-toolbox-client'

import { appendAppLog } from './appLog'

declare global {
  // Toolbox patches read this from a different @bsv/sdk copy than this module.
  var __HANDCASH_VISIBLE_P2PKH_SWEEP: number | undefined
}

/** Total provider requests one build may spend, however many outpoints it covers. */
const MAX_FETCHES_PER_BUILD = 250

/** Minimum spacing between provider requests — what keeps us under rate limits. */
const MIN_REQUEST_GAP_MS = 90

/** Raw transactions are immutable, so a hit is always safe to reuse. */
const MAX_CACHED_TXS = 400

const txCache = new Map<string, Transaction>()

/** Test seam: a fresh build should not inherit a previous test's cache. */
export function resetLegacyBeefCache(): void {
  txCache.clear()
}

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.set(key, value)
  while (cache.size > MAX_CACHED_TXS) {
    const oldest = cache.keys().next()
    if (oldest.done === true) break
    cache.delete(oldest.value)
  }
}

/**
 * Serializes provider calls with a gap between them.
 *
 * Concurrency is what triggered the rate limiting, so requests queue rather than
 * race. A rejected call must not poison the queue for the next one.
 */
let gate: Promise<unknown> = Promise.resolve()

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = gate.then(fn, fn)
  const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_GAP_MS))
  gate = run.then(pause, pause)
  return run
}

type BuildContext = {
  services: Services
  fetches: number
}

function spendFetch(ctx: BuildContext, txid: string): void {
  ctx.fetches += 1
  if (ctx.fetches > MAX_FETCHES_PER_BUILD) {
    throw new Error(`BEEF fetch budget exhausted while resolving ${txid}`)
  }
}

async function loadTx(ctx: BuildContext, txid: string): Promise<Transaction> {
  const cached = txCache.get(txid)
  if (cached) return cached

  spendFetch(ctx, txid)
  // `getRawTx` already rejects a body whose hash doesn't match the txid, so a
  // returned `rawTx` is the transaction we asked for.
  let raw = (await throttled(() => ctx.services.getRawTx(txid))).rawTx
  if (raw == null) {
    // One provider being empty or down is routine; rotate before giving up.
    spendFetch(ctx, txid)
    raw = (await throttled(() => ctx.services.getRawTx(txid, true))).rawTx
  }
  if (raw == null) throw new Error(`no provider had raw transaction ${txid}`)

  const tx = Transaction.fromBinary(raw)
  remember(txCache, txid, tx)
  return tx
}

function beefHasTxBody(beef: Beef): boolean {
  return beef.txs.some((t) => t.tx != null && t.isTxidOnly !== true)
}

/**
 * Toolbox `createAction` / `processAction` refuse an unconfirmed P2PKH deposit
 * because `Beef.verify` wants a merkle chain. Visible-on-chain is the product
 * gate. The toolbox loads its own `@bsv/sdk` copy, so we also set a process
 * flag those patched methods honor.
 */
export async function withVisibleOnChainBeef<T>(work: () => Promise<T>): Promise<T> {
  globalThis.__HANDCASH_VISIBLE_P2PKH_SWEEP = (globalThis.__HANDCASH_VISIBLE_P2PKH_SWEEP ?? 0) + 1
  const proto = Beef.prototype
  const orig = proto.verify
  proto.verify = async function (this: Beef, chainTracker, allowTxidOnly) {
    try {
      if (await orig.call(this, chainTracker, allowTxidOnly)) return true
    } catch {
      // A chaintracker miss is not a confirmation wait.
    }
    return beefHasTxBody(this)
  }
  try {
    return await work()
  } finally {
    proto.verify = orig
    globalThis.__HANDCASH_VISIBLE_P2PKH_SWEEP = Math.max(
      0,
      (globalThis.__HANDCASH_VISIBLE_P2PKH_SWEEP ?? 1) - 1,
    )
  }
}

export type LegacyBeefBuild = {
  /** BEEF covering exactly `ready`. Empty when nothing resolved. */
  beef: BEEF
  /** Outpoints whose source tx body was loaded — safe to hand to the sweep. */
  ready: string[]
  /** Outpoints that could not be loaded this time; they stay retryable. */
  failures: Array<{ outpoint: string; reason: string }>
}

/**
 * Build a BEEF for `outpoints` from each deposit's raw tx only.
 *
 * Outpoints sharing a transaction are loaded once and stand or fall together.
 */
export async function buildLegacyInputBeef(
  services: Services,
  outpoints: string[],
): Promise<LegacyBeefBuild> {
  const failures: Array<{ outpoint: string; reason: string }> = []
  const byTxid = new Map<string, string[]>()

  for (const outpoint of outpoints) {
    const txid = outpoint.split('.')[0]?.trim().toLowerCase() ?? ''
    if (!/^[0-9a-f]{64}$/.test(txid)) {
      failures.push({ outpoint, reason: 'malformed outpoint' })
      continue
    }
    const group = byTxid.get(txid)
    if (group) group.push(outpoint)
    else byTxid.set(txid, [outpoint])
  }

  const ctx: BuildContext = { services, fetches: 0 }
  const beef = new Beef()
  const ready: string[] = []

  for (const [txid, group] of byTxid) {
    const t0 = Date.now()
    try {
      beef.mergeTransaction(await loadTx(ctx, txid))
      ready.push(...group)
      console.info(
        `[legacy-beef] ${txid.slice(0, 12)}… via=tip fetches=${ctx.fetches} ${Date.now() - t0}ms`,
      )
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      for (const outpoint of group) failures.push({ outpoint, reason })
      console.info(
        `[legacy-beef] ${txid.slice(0, 12)}… via=tip FAIL ${Date.now() - t0}ms ${reason}`,
      )
    }
  }

  if (failures.length > 0) {
    appendAppLog(
      'warn',
      `[legacy-beef] ${failures.length} outpoint(s) unreadable this pass: ${failures[0].reason}`,
    )
  }

  return { beef: ready.length > 0 ? beef.toBinary() : [], ready, failures }
}
