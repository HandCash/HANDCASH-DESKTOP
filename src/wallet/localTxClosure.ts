/**
 * Failure is a closure, not a row.
 *
 * Wallet state defines what the wallet owns; the chain only solidifies it. A
 * valid state is one where every spendable output descends from transactions
 * the wallet still stands behind. The toolbox breaks that in one step: failing
 * a transaction restores its inputs and retires its own outputs, but a child
 * that already spent one of those outputs keeps its status and its change stays
 * spendable. The parent's inputs and the child's change are then counted at
 * once — the double balance — and any spend that selects the child's change
 * dies when the toolbox cannot source a failed parent for the BEEF
 * (hc-a580a, 2026-09-29: 4,323,084 → 8,652,598 sats, then a consolidation and
 * a send both built on 828a0685…, which was never on chain).
 *
 * So a local transaction never fails alone: every live local descendant fails
 * with it until no live transaction spends a failed one. The one exception is
 * a descendant the chain already has — that proves the parent verdict wrong,
 * so it is left alone and named.
 *
 * Order matters because the toolbox, on failing a tx, restores that tx's
 * inputs to spendable — including outputs of an already-failed parent. So the
 * closure fails leaves first (a leaf's inputs belong to a still-live parent,
 * which then retires them itself) and afterwards re-retires every output of a
 * dead tx that an orphan spent from. The end state is the invariant: no dead
 * tx has a spendable output, no live tx spends a dead one.
 */
import { Transaction } from '@bsv/sdk'
import { mapPool } from './asyncPool'
import { shouldYieldChainIngestToSpend } from './walletCoordinator'
import type { Chain } from './vault'
import { uiBudgetExpired, yieldToUi } from './yieldToUi'

/** Statuses a local transaction can hold while the chain has not decided it. */
export const LIVE_LOCAL_TX_STATUSES = [
  'unproven',
  'sending',
  'nosend',
  'nonfinal',
  'unsigned',
  'unprocessed',
  'unfail',
] as const

export type LocalTxLink = {
  txid: string
  /** Txids this transaction spends from. */
  inputTxids: readonly string[]
}

/**
 * Live transactions that descend from a failed one, parents before children.
 *
 * Pure: a fixpoint over `live`, seeded by `failed`. Every txid it returns is
 * spent from a failed txid, or from one returned earlier in the list.
 */
export function orphanedDescendants(
  failed: ReadonlySet<string>,
  live: readonly LocalTxLink[],
): string[] {
  const dead = new Set(Array.from(failed, normalize))
  const ordered: string[] = []
  const pending = live.map((link) => ({
    txid: normalize(link.txid),
    inputTxids: link.inputTxids.map(normalize),
  }))
  for (;;) {
    let grew = false
    for (const link of pending) {
      if (dead.has(link.txid)) continue
      if (!link.inputTxids.some((parent) => dead.has(parent))) continue
      dead.add(link.txid)
      ordered.push(link.txid)
      grew = true
    }
    if (!grew) return ordered
  }
}

/**
 * What the chain said about a live descendant. Only `present` is evidence;
 * `unknown` covers 404, silence and errors. The closure fails on `unknown` —
 * wallet state decides, and a mined descendant every explorer misses is the
 * rarer wrong than a phantom that was never broadcast being kept alive.
 */
export type ChainAnswer = 'present' | 'unknown'

export type ClosureKeepReason =
  /** The chain has it, so the failed parent verdict is wrong. */
  | 'onChain'
  /** A confirmed transaction spent it; failing it would restore consumed inputs. */
  | 'ancestorOfOnChain'

export type FailureClosurePlan = {
  /** Fail in this order — leaves first, so each restore lands on a live parent. */
  fail: string[]
  /** Left alone, each with the one reason that excuses it. */
  keep: { txid: string; reason: ClosureKeepReason }[]
  /** Dead transactions whose outputs a failed child spent — retire them again after. */
  retireOutputsOf: string[]
}

/**
 * The whole closure decision, pure.
 *
 * 1. `orphanedDescendants` names every live transaction reachable from a
 *    failed one.
 * 2. A confirmed transaction in that set is a cut: it is kept, and so is every
 *    live ancestor it spent inside the set — the chain consumed those inputs.
 * 3. The reachability is taken again without the kept transactions. What is
 *    left fails, leaves first. A sibling that spends the failed parent
 *    directly and leads nowhere confirmed still fails.
 * 4. Failing a child restores its inputs; those that belong to a dead
 *    transaction are retired again so the pass ends in the invariant.
 */
export function planFailureClosure(args: {
  failed: ReadonlySet<string>
  live: readonly LocalTxLink[]
  chain: ReadonlyMap<string, ChainAnswer>
}): FailureClosurePlan {
  const failed = new Set(Array.from(args.failed, normalize))
  const live = args.live.map((link) => ({
    txid: normalize(link.txid),
    inputTxids: link.inputTxids.map(normalize),
  }))
  const linkByTxid = new Map(live.map((link) => [link.txid, link]))
  const reachable = new Set(orphanedDescendants(failed, live))
  if (reachable.size === 0) return { fail: [], keep: [], retireOutputsOf: [] }

  const onChain = new Set(
    [...reachable].filter((txid) => args.chain.get(txid) === 'present'),
  )
  const keep = new Map<string, ClosureKeepReason>()
  const stack = [...onChain]
  while (stack.length > 0) {
    const txid = stack.pop()!
    if (keep.has(txid)) continue
    keep.set(txid, onChain.has(txid) ? 'onChain' : 'ancestorOfOnChain')
    for (const parent of linkByTxid.get(txid)?.inputTxids ?? []) {
      if (reachable.has(parent) && !keep.has(parent)) stack.push(parent)
    }
  }

  const fail = orphanedDescendants(
    failed,
    live.filter((link) => !keep.has(link.txid)),
  ).reverse()

  const dead = new Set([...failed, ...fail])
  const retire = new Set<string>()
  for (const txid of fail) {
    for (const parent of linkByTxid.get(txid)?.inputTxids ?? []) {
      if (dead.has(parent)) retire.add(parent)
    }
  }
  return {
    fail,
    keep: [...keep].map(([txid, reason]) => ({ txid, reason })),
    retireOutputsOf: [...retire],
  }
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))
const EF_MARKER = [0, 0, 0, 0, 0, 0xef]

/**
 * The parents of a plain serialized transaction, read off the input outpoints
 * without building script objects. Null when the bytes are not exactly one
 * plain transaction — the caller then parses fully.
 */
function scanInputTxids(raw: ArrayLike<number>): string[] | null {
  let at = 4
  const varInt = (): number | null => {
    if (at >= raw.length) return null
    const first = raw[at++]!
    if (first < 0xfd) return first
    const width = first === 0xfd ? 2 : first === 0xfe ? 4 : 8
    if (at + width > raw.length) return null
    let value = 0
    for (let i = width - 1; i >= 0; i -= 1) value = value * 256 + raw[at + i]!
    at += width
    return Number.isSafeInteger(value) ? value : null
  }
  if (EF_MARKER.every((byte, i) => raw[4 + i] === byte)) return null
  const inputs = varInt()
  if (inputs == null) return null
  const ids = new Set<string>()
  for (let n = 0; n < inputs; n += 1) {
    if (at + 36 > raw.length) return null
    let id = ''
    for (let i = 31; i >= 0; i -= 1) id += HEX[raw[at + i]!]
    ids.add(id)
    at += 36
    const script = varInt()
    if (script == null || at + script + 4 > raw.length) return null
    at += script + 4
  }
  const outputs = varInt()
  if (outputs == null) return null
  for (let n = 0; n < outputs; n += 1) {
    at += 8
    const script = varInt()
    if (script == null || at + script > raw.length) return null
    at += script
  }
  return at + 4 === raw.length ? [...ids] : null
}

/** Txids a raw transaction spends from; empty when the bytes cannot be read. */
export function inputTxidsOfRawTx(rawTx: ArrayLike<number> | undefined | null): string[] {
  if (!rawTx || rawTx.length < 10) return []
  const scanned = scanInputTxids(rawTx)
  if (scanned) return scanned
  try {
    const bytes = Array.from(rawTx)
    const extended = EF_MARKER.every((byte, i) => bytes[4 + i] === byte)
    const tx = extended ? Transaction.fromEF(bytes) : Transaction.fromBinary(bytes)
    const ids = new Set<string>()
    for (const input of tx.inputs) {
      const id = input.sourceTXID ?? input.sourceTransaction?.id('hex')
      if (typeof id === 'string' && /^[0-9a-f]{64}$/i.test(id)) ids.add(id.toLowerCase())
    }
    return [...ids]
  } catch {
    return []
  }
}

type StorageTxRow = {
  transactionId?: number
  txid?: string
  status?: string
  rawTx?: number[] | Uint8Array | null
}

type StorageOutputRow = {
  outputId?: number
  spendable?: boolean
  spentBy?: number | null
}

export type ClosureStorage = {
  findTransactions?: (args: {
    partial: Record<string, unknown>
    status?: string[]
    noRawTx?: boolean
    paged: { limit: number; offset: number }
  }) => Promise<StorageTxRow[] | undefined>
  updateTransactionStatus?: (status: string, transactionId: number) => Promise<unknown>
  findOutputs?: (args: {
    partial: Record<string, unknown>
    paged: { limit: number; offset: number }
  }) => Promise<StorageOutputRow[] | undefined>
  updateOutput?: (
    outputId: number,
    patch: { spendable: boolean; spentBy: undefined },
  ) => Promise<unknown>
}

const PAGE = 200
const MAX_PAGES = 25

async function pageTransactions(
  sp: ClosureStorage,
  status: readonly string[],
  noRawTx: boolean,
): Promise<StorageTxRow[]> {
  if (typeof sp.findTransactions !== 'function') return []
  const rows: StorageTxRow[] = []
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch =
      (await sp.findTransactions({
        partial: {},
        status: [...status],
        noRawTx,
        paged: { limit: PAGE, offset: page * PAGE },
      })) ?? []
    rows.push(...batch)
    if (batch.length < PAGE) break
  }
  return rows
}

/**
 * Every output of a dead transaction is unspendable. Idempotent; addresses the
 * rows by `txid` (the column the toolbox writes on every output).
 */
async function retireOutputsOf(sp: ClosureStorage, txid: string): Promise<number> {
  if (typeof sp.findOutputs !== 'function' || typeof sp.updateOutput !== 'function') return 0
  let retired = 0
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch =
      (await sp.findOutputs({
        partial: { txid },
        paged: { limit: PAGE, offset: page * PAGE },
      })) ?? []
    for (const row of batch) {
      if (row.spendable !== true && row.spentBy == null) continue
      const outputId = Number(row.outputId)
      if (!Number.isFinite(outputId) || outputId <= 0) continue
      try {
        await sp.updateOutput(outputId, { spendable: false, spentBy: undefined })
        retired += 1
      } catch (err) {
        console.warn('[tx-closure] retire output skipped', outputId, err)
      }
    }
    if (batch.length < PAGE) break
  }
  return retired
}

export type ClosureOutcome = {
  /** Live descendants of failed transactions that were failed in this pass. */
  failed: string[]
  /** Descendants the chain already has — left alone; the parent verdict is wrong. */
  keptOnChain: string[]
}

type ClosureState = {
  failed: Set<string>
  links: LocalTxLink[]
  byTxid: Map<string, StorageTxRow>
  /** Live descendants of a failed transaction, parents first. */
  reachable: string[]
}

/**
 * Parents of every live transaction seen this session. A txid commits to its
 * bytes, so the answer never changes: after the first pass a closure check
 * reads rows without raw bytes and parses only transactions it has not met.
 */
const inputsByTxid = new Map<string, readonly string[]>()

/** Below this many unseen transactions, raw bytes are fetched row by row instead of paging every live one. */
const RAW_BY_ROW_MAX = 40

type ClosureRead = {
  failed: Set<string>
  /** Live rows without raw bytes, keyed by normalized txid. */
  live: Map<string, StorageTxRow>
  /** Raw bytes of live transactions whose parents are not known yet. */
  unparsed: Array<{ txid: string; rawTx: ArrayLike<number> }>
}

const txidOf = (row: StorageTxRow): string | null => {
  const id = normalize(String(row.txid ?? ''))
  return /^[0-9a-f]{64}$/.test(id) ? id : null
}

async function readRawTxs(
  sp: ClosureStorage,
  rows: readonly StorageTxRow[],
): Promise<ClosureRead['unparsed']> {
  const wanted = new Set(rows.map(txidOf).filter((id): id is string => id != null))
  const found: ClosureRead['unparsed'] = []
  const keep = (row: StorageTxRow) => {
    const txid = txidOf(row)
    if (txid && wanted.delete(txid) && row.rawTx && row.rawTx.length > 0) found.push({ txid, rawTx: row.rawTx })
  }
  if (rows.length > RAW_BY_ROW_MAX || typeof sp.findTransactions !== 'function') {
    for (const row of await pageTransactions(sp, LIVE_LOCAL_TX_STATUSES, false)) keep(row)
    return found
  }
  for (const row of rows) {
    const transactionId = Number(row.transactionId)
    if (!Number.isSafeInteger(transactionId) || transactionId <= 0) continue
    const batch =
      (await sp.findTransactions({
        partial: { transactionId },
        noRawTx: false,
        paged: { limit: 1, offset: 0 },
      })) ?? []
    const hit = batch.find((candidate) => Number(candidate.transactionId) === transactionId)
    if (hit) keep(hit)
  }
  return found
}

/** Storage reads only: failed txs, live txs, and raw bytes for live txs not parsed before. */
async function readClosureRows(
  sp: ClosureStorage,
  seedTxids: readonly string[],
): Promise<ClosureRead | null> {
  const failed = new Set<string>()
  for (const row of await pageTransactions(sp, ['failed'], true)) {
    const id = txidOf(row)
    if (id) failed.add(id)
  }
  for (const seed of seedTxids) failed.add(normalize(seed))
  if (failed.size === 0) return null

  const live = new Map<string, StorageTxRow>()
  for (const row of await pageTransactions(sp, LIVE_LOCAL_TX_STATUSES, true)) {
    const id = txidOf(row)
    if (id) live.set(id, row)
  }
  const unseen = [...live].filter(([txid]) => !inputsByTxid.has(txid)).map(([, row]) => row)
  return { failed, live, unparsed: unseen.length > 0 ? await readRawTxs(sp, unseen) : [] }
}

/**
 * Parse what the read left unparsed, giving the UI a turn whenever the budget
 * runs out. False when `stop` asked to abandon the pass.
 */
async function parseUnparsed(read: ClosureRead, stop: () => boolean = () => false): Promise<boolean> {
  const started = Date.now()
  for (const { txid, rawTx } of read.unparsed) {
    if (uiBudgetExpired()) {
      await yieldToUi()
      if (stop()) return false
    }
    inputsByTxid.set(txid, inputTxidsOfRawTx(rawTx))
  }
  const ms = Date.now() - started
  if (ms >= 250) console.info(`[tx-closure] parse done ${ms}ms — ${read.unparsed.length} transaction(s)`)
  read.unparsed = []
  return true
}

function closureState(read: ClosureRead): ClosureState | null {
  const links: LocalTxLink[] = []
  for (const txid of read.live.keys()) links.push({ txid, inputTxids: inputsByTxid.get(txid) ?? [] })
  const reachable = orphanedDescendants(read.failed, links)
  return reachable.length > 0 ? { failed: read.failed, links, byTxid: read.live, reachable } : null
}

/** Storage reads and in-session parsing: the closure as storage holds it now. */
async function readClosureState(
  sp: ClosureStorage,
  seedTxids: readonly string[],
): Promise<ClosureState | null> {
  const read = await readClosureRows(sp, seedTxids)
  if (!read) return null
  await parseUnparsed(read)
  return closureState(read)
}

/** A transaction an explorer returned stays on chain; asked once per window. */
const PRESENT_MEMO_MS = 30 * 60_000
const presentAt = new Map<string, number>()
const CHAIN_ASK_CONCURRENCY = 4

/** Chain answers for each txid. `present` is remembered; silence is asked again next pass. */
async function askChain(
  txids: readonly string[],
  txExistsOnChain?: (txid: string) => Promise<boolean | null>,
): Promise<{ chain: Map<string, ChainAnswer>; yielded: boolean }> {
  const chain = new Map<string, ChainAnswer>()
  const now = Date.now()
  const ask: string[] = []
  for (const txid of txids) {
    if ((presentAt.get(txid) ?? 0) > now - PRESENT_MEMO_MS) chain.set(txid, 'present')
    else ask.push(txid)
  }
  if (!txExistsOnChain) {
    for (const txid of ask) chain.set(txid, 'unknown')
    return { chain, yielded: false }
  }
  let yielded = false
  await mapPool(ask, CHAIN_ASK_CONCURRENCY, async (txid) => {
    // A waiting send outranks closure: these lookups hold no lock, but a
    // send that waits them out times out with nothing broadcast.
    if (yielded || shouldYieldChainIngestToSpend()) {
      yielded = true
      chain.set(txid, 'unknown')
      return
    }
    let answer: boolean | null = null
    try {
      answer = await txExistsOnChain(txid)
    } catch {
      answer = null
    }
    if (shouldYieldChainIngestToSpend()) yielded = true
    if (answer === true) presentAt.set(txid, Date.now())
    chain.set(txid, answer === true ? 'present' : 'unknown')
  })
  return { chain, yielded }
}

/** Plan from storage state plus chain answers and write it. Storage only. */
async function applyClosure(
  sp: ClosureStorage,
  state: ClosureState,
  chain: ReadonlyMap<string, ChainAnswer>,
): Promise<ClosureOutcome> {
  const outcome: ClosureOutcome = { failed: [], keptOnChain: [] }
  if (typeof sp.updateTransactionStatus !== 'function') return outcome
  const { failed, links, byTxid } = state

  const plan = planFailureClosure({ failed, live: links, chain })
  for (const kept of plan.keep) {
    if (kept.reason === 'onChain') {
      outcome.keptOnChain.push(kept.txid)
      console.warn(
        `[tx-closure] ${kept.txid.slice(0, 12)} is on chain but descends from a failed local tx — parent verdict is wrong; left alone`,
      )
    } else {
      console.warn(
        `[tx-closure] ${kept.txid.slice(0, 12)} left alone — a descendant is already on chain`,
      )
    }
  }
  if (plan.fail.length === 0) return outcome

  for (const txid of plan.fail) {
    const transactionId = Number(byTxid.get(txid)?.transactionId)
    if (!Number.isFinite(transactionId) || transactionId <= 0) continue
    try {
      await sp.updateTransactionStatus('failed', transactionId)
      outcome.failed.push(txid)
    } catch (err) {
      console.warn('[tx-closure] fail descendant skipped', txid.slice(0, 12), err)
    }
  }
  for (const parent of plan.retireOutputsOf) await retireOutputsOf(sp, parent)

  if (outcome.failed.length > 0) {
    console.warn(
      `[tx-closure] failed ${outcome.failed.length} live descendant(s) of failed local tx(s): ${outcome.failed
        .map((id) => id.slice(0, 12))
        .join(', ')}`,
    )
  }
  return outcome
}

/**
 * Fail every live local transaction that descends from a failed one, inside
 * the caller's storage-provider session.
 *
 * `seedTxids` names transactions the caller has just failed (or is about to
 * treat as failed) so their closure is taken in the same pass; with no seeds
 * it is the invariant check — anything the toolbox failed on its own since the
 * last pass gets its closure now. Only for callers that must stay in one
 * session; {@link failOrphanedLocalTxs} asks the chain outside the lock.
 */
export async function failLocalTxClosure(
  sp: ClosureStorage,
  opts: {
    seedTxids?: readonly string[]
    /** Chain proof that a descendant landed; `null` means unknown. */
    txExistsOnChain?: (txid: string) => Promise<boolean | null>
  } = {},
): Promise<ClosureOutcome> {
  const state = await readClosureState(sp, opts.seedTxids ?? [])
  if (!state) return { failed: [], keptOnChain: [] }
  const asked = await askChain(state.reachable, opts.txExistsOnChain)
  if (asked.yielded) return { failed: [], keptOnChain: [] }
  return applyClosure(sp, state, asked.chain)
}

type ClosureWallet = {
  chain: Chain
  wallet?: {
    storage?: {
      runAsStorageProvider?: <T>(fn: (sp: unknown) => Promise<T>) => Promise<T>
    }
  }
}

/**
 * Invariant pass for the active wallet: no live local transaction may spend a
 * failed one. Cheap when nothing has failed; safe to run at every boundary a
 * balance is read or a coin is selected.
 *
 * The storage-provider lock is exclusive — every listOutputs, signAction and
 * BEEF read waits on it — so it is held for storage work only. The closure is
 * read in one session, the chain is asked with no lock held, and a second
 * session re-reads and applies. A closure that grew in between is left for the
 * next pass rather than failed on an answer nobody asked for.
 */
export async function failOrphanedLocalTxs(
  active: ClosureWallet | null | undefined,
  seedTxids: readonly string[] = [],
): Promise<ClosureOutcome> {
  const none: ClosureOutcome = { failed: [], keptOnChain: [] }
  const storage = active?.wallet?.storage
  if (!active || !storage?.runAsStorageProvider) return none
  if (shouldYieldChainIngestToSpend()) return none
  const { txExistsOnChain } = await import('./legacyScan')
  try {
    const readStartedAt = Date.now()
    const read = await storage.runAsStorageProvider((activeSp) =>
      readClosureRows(activeSp as ClosureStorage, seedTxids),
    )
    if (!read) return none
    if (!(await parseUnparsed(read, shouldYieldChainIngestToSpend))) {
      console.info('[tx-closure] deferred — a send is waiting')
      return none
    }
    const asked = closureState(read)
    if (!asked) return none
    if (shouldYieldChainIngestToSpend()) return none
    const askStartedAt = Date.now()
    const chainAsk = await askChain(asked.reachable, (txid) => txExistsOnChain(txid, active.chain))
    const askMs = Date.now() - askStartedAt
    if (chainAsk.yielded) {
      console.info('[tx-closure] deferred — a send is waiting')
      return none
    }
    const chain = chainAsk.chain
    if (askMs >= 250) {
      console.info(
        `[tx-closure] chain check done ${askMs}ms — ${asked.reachable.length} descendant(s), read ${askStartedAt - readStartedAt}ms`,
      )
    }
    const outcome = await storage.runAsStorageProvider(async (activeSp): Promise<ClosureOutcome> => {
      const sp = activeSp as ClosureStorage
      const state = await readClosureState(sp, seedTxids)
      if (!state) return none
      const unasked = state.reachable.filter((txid) => !chain.has(txid))
      if (unasked.length > 0) {
        console.info(
          `[tx-closure] ${unasked.length} new descendant(s) appeared during the chain check — next pass`,
        )
        return none
      }
      return applyClosure(sp, state, chain)
    })
    if (outcome.failed.length > 0) {
      const { releaseTipsOfFailedSends } = await import('./sentItemGuard')
      await releaseTipsOfFailedSends(outcome.failed)
    }
    return outcome
  } catch (err) {
    console.warn('[tx-closure] pass skipped', err)
    return none
  }
}

/** Test-only. */
export function __resetTxClosureMemoForTests(): void {
  presentAt.clear()
  inputsByTxid.clear()
}

function normalize(txid: string): string {
  return txid.trim().toLowerCase()
}
