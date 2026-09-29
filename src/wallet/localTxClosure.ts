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
  const linkByTxid = new Map<string, LocalTxLink>()
  const links: LocalTxLink[] = []
  for (const row of liveRows) {
    const id = normalize(String(row.txid ?? ''))
    if (!/^[0-9a-f]{64}$/.test(id)) continue
    const link = { txid: id, inputTxids: inputTxidsOfRawTx(row.rawTx) }
    byTxid.set(id, row)
    linkByTxid.set(id, link)
    links.push(link)
  }

  const outcome: ClosureOutcome = { failed: [], keptOnChain: [] }
  if (typeof sp.updateTransactionStatus !== 'function') return outcome
  const orphans = orphanedDescendants(failed, links)
  if (orphans.length === 0) return outcome

  // Leaves first: a leaf's inputs belong to a still-live parent, so the
  // toolbox restoring them is consistent until that parent fails in turn.
  const dead = new Set(failed)
  for (const txid of [...orphans].reverse()) {
    const row = byTxid.get(txid)
    const transactionId = Number(row?.transactionId)
    if (!Number.isFinite(transactionId) || transactionId <= 0) continue
    if (opts.txExistsOnChain) {
      let onChain: boolean | null = null
      try {
        onChain = await opts.txExistsOnChain(txid)
      } catch {
        onChain = null
      }
      if (onChain === true) {
        console.warn(
          `[tx-closure] ${txid.slice(0, 12)} is on chain but descends from a failed local tx — parent verdict is wrong; left alone`,
        )
        outcome.keptOnChain.push(txid)
        continue
      }
    }
    try {
      await sp.updateTransactionStatus('failed', transactionId)
      outcome.failed.push(txid)
      dead.add(txid)
    } catch (err) {
      console.warn('[tx-closure] fail descendant skipped', txid.slice(0, 12), err)
    }
  }

  // Failing a child restored its inputs — some of which are outputs of a tx
  // that is itself dead. Retire every output of every dead tx an orphan spent
  // from, so the pass ends in the invariant rather than one step short of it.
  const deadParents = new Set<string>()
  for (const txid of outcome.failed) {
    for (const parent of linkByTxid.get(txid)?.inputTxids ?? []) {
      if (dead.has(parent)) deadParents.add(parent)
    }
  }
  for (const parent of deadParents) await retireOutputsOf(sp, parent)

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
