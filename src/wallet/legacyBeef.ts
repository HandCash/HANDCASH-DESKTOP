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

/** The spacing a run of refused requests backs off to. */
const MAX_REQUEST_GAP_MS = 1_000

/**
 * Pauses before asking again after every provider refused or failed. A
 * rate-limited lookup is not an answer: it once turned mined 2024 deposits
 * into "unmined" and dropped them from an import.
 */
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000]

/** Raw transactions are immutable, so a hit is always safe to reuse. */
const MAX_CACHED_TXS = 400

const txCache = new Map<string, Transaction>()

let requestGapMs = MIN_REQUEST_GAP_MS
let retryDelaysMs = DEFAULT_RETRY_DELAYS_MS

/** Test seam: a fresh build should not inherit a previous test's cache. */
export function resetLegacyBeefCache(opts: { retryDelaysMs?: readonly number[] } = {}): void {
  txCache.clear()
  nextStartAt = 0
  requestGapMs = MIN_REQUEST_GAP_MS
  retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
}

/** Every provider refused or failed: space the whole build's requests further apart. */
function providersRefused(): void {
  requestGapMs = Math.min(MAX_REQUEST_GAP_MS, requestGapMs * 2)
}

function providerAnswered(): void {
  requestGapMs = Math.max(MIN_REQUEST_GAP_MS, Math.round(requestGapMs * 0.9))
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

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

/**
 * `now`: a transaction is waiting on this read. `ahead`: warming a later
 * chunk. A prefetch of the next hundred items queued ahead of the leg being
 * signed once held that leg's parents for 217s.
 */
export type ReadPriority = 'now' | 'ahead'

let inFlight = 0
let nextStartAt = 0
let wake: ReturnType<typeof setTimeout> | null = null
const waiting: Record<ReadPriority, Array<() => void>> = { now: [], ahead: [] }

/** Start queued calls, `now` before `ahead`, spaced `requestGapMs` apart, up to `MAX_IN_FLIGHT`. */
function pump(): void {
  while (inFlight < MAX_IN_FLIGHT && (waiting.now.length > 0 || waiting.ahead.length > 0)) {
    const now = Date.now()
    if (now < nextStartAt) {
      wake ??= setTimeout(() => {
        wake = null
        pump()
      }, nextStartAt - now)
      return
    }
    nextStartAt = now + requestGapMs
    inFlight += 1
    ;(waiting.now.shift() ?? waiting.ahead.shift())!()
  }
}

/**
 * Spaces provider calls and caps how many run at once.
 *
 * Bursts are what triggered the rate limiting, so starts stay spaced; waiting
 * for each answer before the next start made a 100-item import read its
 * source transactions one round trip at a time. A rejected call frees its slot.
 */
async function throttled<T>(priority: ReadPriority, fn: () => Promise<T>): Promise<T> {
  await new Promise<void>((resolve) => {
    waiting[priority].push(resolve)
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
  priority: ReadPriority
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

  // `getRawTx` already rejects a body whose hash doesn't match the txid, so a
  // returned `rawTx` is the transaction we asked for. One provider being empty
  // or down is routine: rotate at once, then pause between later rounds.
  for (let attempt = 0; ; attempt += 1) {
    spendFetch(ctx, txid)
    const raw = (await throttled(ctx.priority, () => ctx.services.getRawTx(txid, attempt > 0)).catch(() => null))?.rawTx
    if (raw != null) {
      providerAnswered()
      const tx = Transaction.fromBinary(raw)
      remember(txCache, txid, tx)
      return tx
    }
    if (attempt === 0) continue
    const delay = retryDelaysMs[attempt - 1]
    if (delay == null) throw new Error(`no provider had raw transaction ${txid}`)
    providersRefused()
    await sleep(delay)
  }
}

/** `unanswered`: every provider refused or failed, so nothing is known about the block. */
type ProofLookup = 'proven' | 'unmined' | 'unanswered'

type MerklePathNotes = { notes?: ReadonlyArray<{ name?: string; what?: string }> }

/**
 * Only WhatsOnChain's own "no proof" means unmined. Arcade and Bitails 404
 * mined 2024 transactions, and Bitails reports a 429 as a note, not an error.
 */
function whatsOnChainHasNoProof(result: MerklePathNotes): boolean {
  return (result.notes ?? []).some(
    (note) => note.name === 'WoCTsc' && (note.what === 'getMerklePathNotFound' || note.what === 'getMerklePathNoData'),
  )
}

/** Proofs are cached only once found — a mempool miss must be asked again. */
async function attachMerklePath(ctx: BuildContext, tx: Transaction, txid: string): Promise<ProofLookup> {
  if (tx.merklePath) return 'proven'
  for (let attempt = 0; ; attempt += 1) {
    spendFetch(ctx, txid)
    const found = await throttled(ctx.priority, () => ctx.services.getMerklePath(txid, attempt > 0)).catch(() => null)
    if (found?.merklePath) {
      providerAnswered()
      tx.merklePath = found.merklePath
      return 'proven'
    }
    if (found && whatsOnChainHasNoProof(found as MerklePathNotes)) return 'unmined'
    const delay = retryDelaysMs[attempt]
    if (delay == null) return 'unanswered'
    providersRefused()
    await sleep(delay)
  }
}

function unansweredProof(txid: string): Error {
  return new Error(`no provider answered for the proof of ${txid.slice(0, 12)}; try again shortly`)
}

/**
 * The deposit with an SPV-checkable proof: its own path, or every parent's.
 * Throws a retryable reason when neither exists yet, and says which: a block
 * still to come, or providers that did not answer.
 */
async function provenDeposit(ctx: BuildContext, txid: string): Promise<Transaction> {
  const tx = await loadTx(ctx, txid)
  const own = await attachMerklePath(ctx, tx, txid)
  if (own === 'proven') return tx
  if (own === 'unanswered') throw unansweredProof(txid)
  for (const input of tx.inputs) {
    const parentTxid = String(input.sourceTXID ?? '').toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(parentTxid)) {
      throw new Error(`deposit ${txid.slice(0, 12)} names no parent txid`)
    }
    const parent = await loadTx(ctx, parentTxid)
    const proof = await attachMerklePath(ctx, parent, parentTxid)
    if (proof === 'unanswered') throw unansweredProof(parentTxid)
    if (proof === 'unmined') {
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
  options?: { concurrency?: number; priority?: ReadPriority },
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

  const ctx: BuildContext = { services, fetches: 0, priority: options?.priority ?? 'now' }
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
