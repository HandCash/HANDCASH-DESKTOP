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

/**
 * Whether the referenced local transaction still binds those coins.
 *
 * `settled` must remain distinct from `pending`: both prove an input was spent,
 * but only pending transactions may contribute not-yet-spendable change. BRC-39
 * merges can retain old completed change rows with `spendable: false`; treating
 * those as pending credits historical change on top of today's spendable set.
 */
export type TxLiveness = 'pending' | 'settled' | 'dead' | 'none'

export type OwnedCashFate =
  | { kind: 'count'; as: 'spendable' | 'unconfirmedChange'; satoshis: number }
  | {
      kind: 'exclude'
      reason: 'noValue' | 'item' | 'bsv21' | 'spentLive' | 'notOurs'
    }

const PAGE = 200
const MAX_PAGES = 10

export function txLivenessFromStatus(status: unknown): TxLiveness {
  const normalized = String(status ?? '').toLowerCase()
  if (!normalized) return 'none'
  if (normalized === 'completed') return 'settled'
  return isLiveLocalTxStatus(normalized) ? 'pending' : 'dead'
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

  if (spender === 'pending' || spender === 'settled') {
    return { kind: 'exclude', reason: 'spentLive' }
  }

  if (row.spendable === true) {
    return { kind: 'count', as: 'spendable', satoshis }
  }

  if (row.change === true && creator === 'pending') {
    return { kind: 'count', as: 'unconfirmedChange', satoshis }
  }

  return { kind: 'exclude', reason: 'notOurs' }
}

type TxStatusRow = { status?: string }

function positiveId(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Change of live local txs that toolbox `balance()` does not yet count
 * (`spendable: false`). Inputs of those txs are excluded via `spentLive`.
 *
 * Runs in **one** storage session for the whole scan. A page of outputs plus
 * every tx-liveness lookup used to each open their own session — on a phone
 * carrying hundreds of unspendable rows that was the bulk of the 6s wait
 * before `createAction`.
 *
 * `needAtLeast` stops early once enough credit is found (send gate only needs
 * to know the payment is covered, not the full hero total).
 */
export async function unconfirmedChangeSats(opts?: {
  needAtLeast?: number
}): Promise<number> {
  const active = getActiveWallet()
  const storage = active?.wallet?.storage
  if (!storage?.runAsStorageProvider) return 0
  const needAtLeast =
    typeof opts?.needAtLeast === 'number' && opts.needAtLeast > 0
      ? Math.floor(opts.needAtLeast)
      : 0

  try {
    return await storage.runAsStorageProvider(async (activeSp) => {
      const sp = activeSp as {
        findOutputs?: (args: unknown) => Promise<unknown[] | undefined>
        findTransactions?: (args: unknown) => Promise<TxStatusRow[] | undefined>
      }
      if (typeof sp.findOutputs !== 'function') return 0

      let extra = 0
      const txCache = new Map<number, TxLiveness>()

      const livenessOf = async (txId: number | null): Promise<TxLiveness> => {
        if (txId == null) return 'none'
        const cached = txCache.get(txId)
        if (cached != null) return cached
        if (typeof sp.findTransactions !== 'function') {
          txCache.set(txId, 'none')
          return 'none'
        }
        try {
          const rows = await sp.findTransactions({
            partial: { transactionId: txId },
            noRawTx: true,
            paged: { limit: 1, offset: 0 },
          })
          const live = txLivenessFromStatus(rows?.[0]?.status)
          txCache.set(txId, live)
          return live
        } catch {
          txCache.set(txId, 'none')
          return 'none'
        }
      }

      for (let page = 0; page < MAX_PAGES; page += 1) {
        let batch: Array<OwnedCashRow & { transactionId?: number }> = []
        try {
          batch = ((await sp.findOutputs({
            partial: { spendable: false, change: true },
            paged: { limit: PAGE, offset: page * PAGE },
          })) ?? []) as typeof batch
        } catch {
          batch = ((await sp.findOutputs({
            partial: { spendable: false },
            paged: { limit: PAGE, offset: page * PAGE },
          })) ?? []) as typeof batch
        }
        if (!batch.length) break

        for (const row of batch) {
          if (row.change !== true) continue
          const fate = classifyOwnedCash(
            row,
            await livenessOf(positiveId(row.transactionId)),
            await livenessOf(positiveId(row.spentBy)),
          )
          if (fate.kind === 'count' && fate.as === 'unconfirmedChange') {
            extra += fate.satoshis
            if (needAtLeast > 0 && extra >= needAtLeast) return extra
          }
        }
        if (batch.length < PAGE) break
      }
      return extra
    })
  } catch (err) {
    console.warn('[balance-view] unconfirmed change credit skipped', err)
    return 0
  }
}
