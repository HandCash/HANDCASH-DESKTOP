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
import type { Chain } from './vault'

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

/** Txids a raw transaction spends from; empty when the bytes cannot be read. */
export function inputTxidsOfRawTx(rawTx: ArrayLike<number> | undefined | null): string[] {
  if (!rawTx || rawTx.length === 0) return []
  try {
    const tx = Transaction.fromBinary(Array.from(rawTx))
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

/**
 * Fail every live local transaction that descends from a failed one.
 *
 * Runs inside a storage-provider session. `seedTxids` names transactions the
 * caller has just failed (or is about to treat as failed) so their closure is
 * taken in the same pass; with no seeds it is the invariant check — anything
 * the toolbox failed on its own since the last pass gets its closure now.
 */
export async function failLocalTxClosure(
  sp: ClosureStorage,
  opts: {
    seedTxids?: readonly string[]
    /** Chain proof that a descendant landed; `null` means unknown. */
    txExistsOnChain?: (txid: string) => Promise<boolean | null>
  } = {},
): Promise<ClosureOutcome> {
  const failedRows = await pageTransactions(sp, ['failed'], true)
  const failed = new Set<string>()
  for (const row of failedRows) {
    const id = normalize(String(row.txid ?? ''))
    if (/^[0-9a-f]{64}$/.test(id)) failed.add(id)
  }
  for (const seed of opts.seedTxids ?? []) failed.add(normalize(seed))
  if (failed.size === 0) return { failed: [], keptOnChain: [] }

  const liveRows = await pageTransactions(sp, LIVE_LOCAL_TX_STATUSES, false)
  const byTxid = new Map<string, StorageTxRow>()
  const links: LocalTxLink[] = []
  for (const row of liveRows) {
    const id = normalize(String(row.txid ?? ''))
    if (!/^[0-9a-f]{64}$/.test(id)) continue
    byTxid.set(id, row)
    links.push({ txid: id, inputTxids: inputTxidsOfRawTx(row.rawTx) })
  }

  const outcome: ClosureOutcome = { failed: [], keptOnChain: [] }
  if (typeof sp.updateTransactionStatus !== 'function') return outcome
  const reachable = orphanedDescendants(failed, links)
  if (reachable.length === 0) return outcome

  // Ask the chain about every reachable descendant once; the plan reads the
  // answers, it never asks.
  const chain = new Map<string, ChainAnswer>()
  if (opts.txExistsOnChain) {
    for (const txid of reachable) {
      let answer: boolean | null = null
      try {
        answer = await opts.txExistsOnChain(txid)
      } catch {
        answer = null
      }
      chain.set(txid, answer === true ? 'present' : 'unknown')
    }
  }

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
 */
export async function failOrphanedLocalTxs(
  active: ClosureWallet | null | undefined,
  seedTxids: readonly string[] = [],
): Promise<ClosureOutcome> {
  const storage = active?.wallet?.storage
  if (!active || !storage?.runAsStorageProvider) return { failed: [], keptOnChain: [] }
  const { txExistsOnChain } = await import('./legacyScan')
  try {
    return await storage.runAsStorageProvider(async (activeSp) =>
      failLocalTxClosure(activeSp as ClosureStorage, {
        seedTxids,
        txExistsOnChain: (txid) => txExistsOnChain(txid, active.chain),
      }),
    )
  } catch (err) {
    console.warn('[tx-closure] pass skipped', err)
    return { failed: [], keptOnChain: [] }
  }
}

function normalize(txid: string): string {
  return txid.trim().toLowerCase()
}
