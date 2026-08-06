/**
 * Builds the input BEEF for a legacy P2PKH sweep.
 *
 * `SetupClient.fundWalletFromP2PKHOutpoints` builds one itself when callers
 * don't supply it, and that builder is why incoming payments stopped arriving.
 * It reads raw transactions from two hardcoded URLs and asks GorillaPool alone
 * for merkle proofs. When a proof comes back empty it walks every parent input
 * instead — so one silent proof miss fans out into a fetch per ancestor per
 * level against the same two hosts it depends on. They rate-limit, the throttled
 * response carries no CORS headers so the browser reports `TypeError: Failed to
 * fetch`, the walk throws, and the throw is not caught per outpoint: it takes
 * the entire scan with it. Every deposit in the batch is lost, including the
 * ones that were fine, and the user sees a payment that simply never arrives.
 *
 * This builder answers the same question through the toolbox's own service
 * rotation (which knows more than two providers and tracks their health),
 * remembers answers that can never change, spaces requests out, and keeps each
 * outpoint's failure to itself.
 */
import { Beef, Transaction, type BEEF, type MerklePath } from '@bsv/sdk'
import type { Services } from '@bsv/wallet-toolbox-client'

import { appendAppLog } from './appLog'

/**
 * How far back an unproven chain may be walked.
 *
 * Every level without a proof multiplies the request count by the input count,
 * so this is a blast radius limit, not a correctness one. Legitimate unconfirmed
 * chains from legacy wallets are a handful of transactions deep.
 */
const MAX_DEPTH = 8

/** Total provider requests one build may spend, however many outpoints it covers. */
const MAX_FETCHES_PER_BUILD = 250

/** Minimum spacing between provider requests — what keeps us under rate limits. */
const MIN_REQUEST_GAP_MS = 90

/** Raw transactions and proofs are immutable, so a hit is always safe to reuse. */
const MAX_CACHED_TXS = 400

const txCache = new Map<string, Transaction>()
const proofCache = new Map<string, MerklePath>()

/** Test seam: a fresh build should not inherit a previous test's cache. */
export function resetLegacyBeefCache(): void {
  txCache.clear()
  proofCache.clear()
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
  /** Transactions known to have no proof yet — negative results expire with the build. */
  unproven: Set<string>
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

async function loadProof(ctx: BuildContext, txid: string): Promise<MerklePath | null> {
  const cached = proofCache.get(txid)
  if (cached) return cached
  if (ctx.unproven.has(txid)) return null

  spendFetch(ctx, txid)
  try {
    const { merklePath } = await throttled(() => ctx.services.getMerklePath(txid))
    if (merklePath != null) {
      remember(proofCache, txid, merklePath)
      return merklePath
    }
  } catch {
    // No proof and a proof that couldn't be asked for are the same thing here:
    // walk the parents. A wrong answer would corrupt the BEEF; no answer won't.
  }
  ctx.unproven.add(txid)
  return null
}

/**
 * Collects `txid` and every ancestor needed to prove it, parents before children.
 *
 * Throws if any of them can't be resolved — the caller decides what that costs,
 * which is the whole point: it costs one outpoint, not the batch.
 */
async function collect(
  ctx: BuildContext,
  txid: string,
  depth: number,
  out: Map<string, Transaction>,
): Promise<void> {
  if (out.has(txid)) return

  const tx = await loadTx(ctx, txid)
  const proof = await loadProof(ctx, txid)
  if (proof != null) {
    tx.merklePath = proof
    out.set(txid, tx)
    return
  }

  if (depth >= MAX_DEPTH) {
    throw new Error(`unproven ancestry deeper than ${MAX_DEPTH} at ${txid}`)
  }
  for (const input of tx.inputs) {
    if (input.sourceTXID != null) {
      await collect(ctx, input.sourceTXID, depth + 1, out)
    }
  }
  out.set(txid, tx)
}

export type LegacyBeefBuild = {
  /** BEEF covering exactly `ready`. Empty when nothing resolved. */
  beef: BEEF
  /** Outpoints the BEEF can prove — safe to hand to the sweep. */
  ready: string[]
  /** Outpoints that could not be proven this time; they stay retryable. */
  failures: Array<{ outpoint: string; reason: string }>
}

/**
 * Build a BEEF proving `outpoints`, skipping the ones it can't.
 *
 * Outpoints sharing a transaction are walked once and stand or fall together,
 * because they are the same evidence.
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

  const ctx: BuildContext = { services, fetches: 0, unproven: new Set() }
  const beef = new Beef()
  const ready: string[] = []

  for (const [txid, group] of byTxid) {
    const collected = new Map<string, Transaction>()
    try {
      await collect(ctx, txid, 0, collected)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      for (const outpoint of group) failures.push({ outpoint, reason })
      continue
    }
    for (const tx of collected.values()) beef.mergeTransaction(tx)
    ready.push(...group)
  }

  if (failures.length > 0) {
    appendAppLog(
      'warn',
      `[legacy-beef] ${failures.length} outpoint(s) unprovable this pass: ${failures[0].reason}`,
    )
  }

  return { beef: ready.length > 0 ? beef.toBinary() : [], ready, failures }
}
