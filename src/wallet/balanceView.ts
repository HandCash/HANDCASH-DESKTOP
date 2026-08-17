/**
 * Owned-cash heuristic for the displayed BSV balance (`balanceView`).
 *
 * Toolbox `Wallet.balance()` sums `spendable: true` outputs. After createAction
 * the inputs leave that set immediately and the change often stays
 * `spendable: false` until an indexer agrees it is a UTXO — so the hero number
 * drops by the payment **and** the change (every sat of the selected inputs).
 *
 * What you still own is not "spendable according to the indexer". It is:
 *
 *   remaining spendable coins
 *   + change of a live local transaction that nobody has spent yet
 *
 * Payment outputs are not ours. Inputs of a live local send are not ours.
 * 1-sat items and BSV-21 stay out of Pay.
 */
import { getActiveWallet } from './session'
import { isLiveLocalTxStatus } from './staleOutputRelease'

export type OwnedCashRow = {
  satoshis?: number
  change?: boolean
  spendable?: boolean
  spentBy?: number
  basket?: string
}

/** Whether the referenced local transaction still binds those coins. */
export type TxLiveness = 'live' | 'dead' | 'none'

export type OwnedCashFate =
  | { kind: 'count'; as: 'spendable' | 'unconfirmedChange'; satoshis: number }
  | {
      kind: 'exclude'
      reason: 'noValue' | 'item' | 'bsv21' | 'spentLive' | 'notOurs'
    }

const PAGE = 200
const MAX_PAGES = 10

export function txLivenessFromStatus(status: unknown): TxLiveness {
  if (status == null || status === '') return 'none'
  return isLiveLocalTxStatus(status) ? 'live' : 'dead'
}

/**
 * One output's contribution to displayed owned cash.
 *
 * `spender` is the tx in `spentBy` (`none` when the output is unspent).
 * `creator` is the tx that produced the output.
 */
export function classifyOwnedCash(
  row: OwnedCashRow,
  creator: TxLiveness,
  spender: TxLiveness,
): OwnedCashFate {
  const satoshis = Math.max(0, Math.trunc(Number(row.satoshis) || 0))
  if (satoshis <= 0) return { kind: 'exclude', reason: 'noValue' }

  const basket = String(row.basket ?? '').toLowerCase()
  if (basket === '1sat') return { kind: 'exclude', reason: 'item' }
  if (basket === 'bsv21') return { kind: 'exclude', reason: 'bsv21' }

  if (spender === 'live') return { kind: 'exclude', reason: 'spentLive' }

  if (row.spendable === true) {
    return { kind: 'count', as: 'spendable', satoshis }
  }

  if (row.change === true && creator === 'live') {
    return { kind: 'count', as: 'unconfirmedChange', satoshis }
  }

  return { kind: 'exclude', reason: 'notOurs' }
}

type TxStatusRow = { status?: string }

function positiveId(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

type LivenessStorage = {
  runAsStorageProvider: <T>(fn: (sp: unknown) => Promise<T>) => Promise<T>
}

/**
 * Resolve every tx id a page needs inside **one** storage session.
 *
 * Each `runAsStorageProvider` acquires a storage session, and this loop used to
 * take two of them per output row — hundreds of sequential IndexedDB round trips
 * on the UI thread, which is where a phone spent ~6s before `createAction` on
 * every send. The queries themselves are cheap; entering the provider is not.
 */
async function cacheLivenessOf(
  storage: LivenessStorage,
  txIds: Iterable<number>,
  cache: Map<number, TxLiveness>,
): Promise<void> {
  const missing = [...new Set(txIds)].filter((id) => !cache.has(id))
  if (missing.length === 0) return
  try {
    const statuses = await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as {
        findTransactions?: (args: unknown) => Promise<TxStatusRow[] | undefined>
      }
      if (typeof sp.findTransactions !== 'function') return null
      const out = new Map<number, unknown>()
      for (const id of missing) {
        const rows = await sp.findTransactions({
          partial: { transactionId: id },
          noRawTx: true,
          paged: { limit: 1, offset: 0 },
        })
        out.set(id, rows?.[0]?.status)
      }
      return out
    })
    for (const id of missing) {
      cache.set(id, statuses ? txLivenessFromStatus(statuses.get(id)) : 'none')
    }
  } catch (err) {
    console.warn('[balance-view] tx liveness batch skipped', err)
    // Unknown status is not evidence the tx is live, and `none` is what a single
    // failed lookup already resolved to.
    for (const id of missing) cache.set(id, 'none')
  }
}

/**
 * Change of live local txs that toolbox `balance()` does not yet count
 * (`spendable: false`). Inputs of those txs are excluded via `spentLive`.
 */
export async function unconfirmedChangeSats(): Promise<number> {
  const active = getActiveWallet()
  const storage = active?.wallet?.storage
  if (!storage?.runAsStorageProvider) return 0

  try {
    let extra = 0
    const txCache = new Map<number, TxLiveness>()
    const liveness = (txId: number | null): TxLiveness =>
      txId == null ? 'none' : txCache.get(txId) ?? 'none'

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const batch = (await storage.runAsStorageProvider(async (activeSp) => {
        const sp = activeSp as {
          findOutputs?: (args: unknown) => Promise<unknown[] | undefined>
        }
        if (typeof sp.findOutputs !== 'function') return []
        try {
          return await sp.findOutputs({
            partial: { spendable: false, change: true },
            paged: { limit: PAGE, offset: page * PAGE },
          })
        } catch {
          return sp.findOutputs({
            partial: { spendable: false },
            paged: { limit: PAGE, offset: page * PAGE },
          })
        }
      })) as Array<OwnedCashRow & { transactionId?: number }> | undefined
      if (!batch?.length) break

      const changeRows = batch.filter((row) => row.change === true)
      const needed: number[] = []
      for (const row of changeRows) {
        const creator = positiveId(row.transactionId)
        const spender = positiveId(row.spentBy)
        if (creator != null) needed.push(creator)
        if (spender != null) needed.push(spender)
      }
      await cacheLivenessOf(storage as LivenessStorage, needed, txCache)

      for (const row of changeRows) {
        const fate = classifyOwnedCash(
          row,
          liveness(positiveId(row.transactionId)),
          liveness(positiveId(row.spentBy)),
        )
        if (fate.kind === 'count' && fate.as === 'unconfirmedChange') {
          extra += fate.satoshis
        }
      }
      if (batch.length < PAGE) break
    }
    return extra
  } catch (err) {
    console.warn('[balance-view] unconfirmed change credit skipped', err)
    return 0
  }
}
