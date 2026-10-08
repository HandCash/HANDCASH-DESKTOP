/**
 * Builds the input BEEF for a legacy P2PKH sweep.
 *
 * The toolbox calls `Beef.verify` (SPV) inside `createAction`, and that
 * verification is authoritative: seeing a transaction body is not proof that
 * its outputs are valid or spendable. A bare deposit body therefore fails
 * every time ("must be valid Beef when factoring options.trustSelf").
 *
 * So each deposit carries a proof: its own merkle path once mined, or — while
 * it sits in mempool — the merkle-proven transactions it spends. One level
 * only; a deposit whose parents are also unmined waits for the next block and
 * stays retryable.
 */
import { Beef, Transaction, type BEEF } from '@bsv/sdk'
import type { Services } from '@bsv/wallet-toolbox-client'

import { appendAppLog } from './appLog'

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
  nextStartAt = 0
}

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.set(key, value)
  while (cache.size > MAX_CACHED_TXS) {
    const oldest = cache.keys().next()
    if (oldest.done === true) break
    cache.delete(oldest.value)
  }
}

/** Provider calls allowed in flight at once. */
const MAX_IN_FLIGHT = 4

let inFlight = 0
let nextStartAt = 0
let wake: ReturnType<typeof setTimeout> | null = null
const waiting: Array<() => void> = []

/** Start queued calls, spaced `MIN_REQUEST_GAP_MS` apart, up to `MAX_IN_FLIGHT`. */
function pump(): void {
  while (inFlight < MAX_IN_FLIGHT && waiting.length > 0) {
    const now = Date.now()
    if (now < nextStartAt) {
      wake ??= setTimeout(() => {
        wake = null
        pump()
      }, nextStartAt - now)
      return
    }
    nextStartAt = now + MIN_REQUEST_GAP_MS
    inFlight += 1
    waiting.shift()!()
  }
}

/**
 * Spaces provider calls and caps how many run at once.
 *
 * Bursts are what triggered the rate limiting, so starts stay spaced; waiting
 * for each answer before the next start made a 100-item import read its
 * source transactions one round trip at a time. A rejected call frees its slot.
 */
async function throttled<T>(fn: () => Promise<T>): Promise<T> {
  await new Promise<void>((resolve) => {
    waiting.push(resolve)
    pump()
  })
  try {
    return await fn()
  } finally {
    inFlight -= 1
    pump()
  }
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

/** Proofs are cached only once found — a mempool miss must be asked again. */
async function attachMerklePath(ctx: BuildContext, tx: Transaction, txid: string): Promise<boolean> {
  if (tx.merklePath) return true
  spendFetch(ctx, txid)
  const found = await throttled(() => ctx.services.getMerklePath(txid)).catch(() => null)
  if (!found?.merklePath) return false
  tx.merklePath = found.merklePath
  return true
}

/**
 * The deposit with an SPV-checkable proof: its own path, or every parent's.
 * Throws a retryable reason when neither exists yet.
 */
async function provenDeposit(ctx: BuildContext, txid: string): Promise<Transaction> {
  const tx = await loadTx(ctx, txid)
  if (await attachMerklePath(ctx, tx, txid)) return tx
  for (const input of tx.inputs) {
    const parentTxid = String(input.sourceTXID ?? '').toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(parentTxid)) {
      throw new Error(`deposit ${txid.slice(0, 12)} names no parent txid`)
    }
    const parent = await loadTx(ctx, parentTxid)
    if (!(await attachMerklePath(ctx, parent, parentTxid))) {
      throw new Error(`deposit ${txid.slice(0, 12)} and its parents are unmined; waiting for a block`)
    }
    input.sourceTransaction = parent
  }
  return tx
}

/**
 * Compatibility wrapper retained for existing call sites. Validation is
 * intentionally delegated to Wallet Toolbox without mutating global state or
 * overriding `Beef.verify`.
 */
export async function withVisibleOnChainBeef<T>(work: () => Promise<T>): Promise<T> {
  return work()
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
 * `concurrency` fetches several source transactions at a time — a collection
 * migrate is otherwise dominated by one serial round trip per tip.
 */
export async function buildLegacyInputBeef(
  services: Services,
  outpoints: string[],
  options?: { concurrency?: number },
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
  const groups = [...byTxid.entries()]
  const lanes = Math.max(1, Math.min(Math.floor(options?.concurrency ?? 1), 12))

  let cursor = 0
  const worker = async () => {
    while (cursor < groups.length) {
      const index = cursor
      cursor += 1
      const [txid, group] = groups[index]!
      const t0 = Date.now()
      try {
        const tx = await provenDeposit(ctx, txid)
        // Merge on the awaiting side only: Beef is not reentrant.
        beef.mergeTransaction(tx)
        ready.push(...group)
        console.info(
          `[legacy-beef] ${txid.slice(0, 12)}… via=${tx.merklePath ? 'proof' : 'parents'} fetches=${ctx.fetches} ${Date.now() - t0}ms`,
        )
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        for (const outpoint of group) failures.push({ outpoint, reason })
        console.info(
          `[legacy-beef] ${txid.slice(0, 12)}… via=tip FAIL ${Date.now() - t0}ms ${reason}`,
        )
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(lanes, groups.length) }, () => worker()))

  if (failures.length > 0) {
    appendAppLog(
      'warn',
      `[legacy-beef] ${failures.length} outpoint(s) unreadable this pass: ${failures[0].reason}`,
    )
  }

  return { beef: ready.length > 0 ? beef.toBinary() : [], ready, failures }
}
