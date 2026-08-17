/**
 * Background reconciliation — converge optimistic Tx/UTXO layer with chain truth.
 *
 * Runs inside chain ingest (or on resume). Polls merkle/SPV for pending txs,
 * advances MINED when BUMP verifies, rolls back rejects, thaws frozen UTXOs
 * that the indexer still shows as spendable.
 */
import { tryFinalizeDualLayerTx } from './dualLayerSend'
import { txExistsOnChain } from './legacyScan'
import { getActiveWallet } from './session'
import { listPendingConfirmation,
  listTxRecords,
  markTxFailed,
  markTxReorgOrphaned,
  transitionTx,
} from './txStore'
import { listUtxoLocks, rollbackLocks, thawUtxo } from './utxoLockManager'
import { shouldYieldChainIngestToSpend } from './walletCoordinator'

export type TxReconcileResult = {
  checked: number
  mined: number
  failed: number
  orphaned: number
  thawed: number
  rolledBack: number
}

/**
 * One reconcile pass over pending confirmation txs + frozen UTXOs.
 * Safe to call from chainIngest — no spend-path invention.
 */
export async function reconcileDualLayerState(): Promise<TxReconcileResult> {
  const result: TxReconcileResult = {
    checked: 0,
    mined: 0,
    failed: 0,
    orphaned: 0,
    thawed: 0,
    rolledBack: 0,
  }

  const active = getActiveWallet()
  const chain = active?.chain
  if (!chain) return result

  const pending = listPendingConfirmation()
  for (const rec of pending) {
    if (shouldYieldChainIngestToSpend()) break
    result.checked += 1
    if (!rec.txid) {
      // Broadcasting without txid for > 10 minutes → fail + unlock.
      if (Date.now() - rec.updatedAt > 10 * 60_000) {
        markTxFailed(rec.id, 'UNKNOWN', 'Broadcast never produced a txid')
        result.rolledBack += rollbackLocks(rec.id)
        result.failed += 1
      }
      continue
    }

    try {
      const onChain = await txExistsOnChain(rec.txid, chain)
      if (onChain === false && rec.status === 'SEEN_IN_MEMPOOL') {
        // Evicted / never landed — fail closed after grace.
        if (Date.now() - rec.updatedAt > 30 * 60_000) {
          markTxFailed(rec.id, 'ARC_REJECTED', 'Transaction missing from chain after grace')
          result.rolledBack += rollbackLocks(rec.id)
          result.failed += 1
        }
        continue
      }

      const before = rec.status
      const after = await tryFinalizeDualLayerTx(rec.id)
      if (after?.status === 'MINED' && before !== 'MINED') result.mined += 1
    } catch (err) {
      console.warn('[tx-reconcile] pending check failed', rec.txid, err)
    }
  }

  // Mined txs that disappear from chain → reorg orphan.
  for (const rec of listTxRecords()) {
    if (rec.status !== 'MINED' || !rec.txid) continue
    try {
      const onChain = await txExistsOnChain(rec.txid, chain)
      if (onChain === false) {
        markTxReorgOrphaned(rec.id)
        result.orphaned += 1
      }
    } catch {
      // inconclusive — leave mined
    }
  }

  // Thaw frozen UTXOs after 24h with no owner (reconcile may re-lock later).
  for (const lock of listUtxoLocks()) {
    if (lock.status !== 'quarantine') continue
    if (Date.now() - lock.updatedAt < 24 * 60 * 60_000) continue
    thawUtxo(lock.outpoint)
    result.thawed += 1
  }

  // Promote REORG_ORPHANED back toward mempool when still broadcastable.
  for (const rec of listTxRecords()) {
    if (rec.status !== 'REORG_ORPHANED' || !rec.txid) continue
    try {
      const onChain = await txExistsOnChain(rec.txid, chain)
      if (onChain === true) {
        transitionTx(rec.id, 'SEEN_IN_MEMPOOL', {
          diagnostic: null,
          diagnosticDetail: null,
        })
        await tryFinalizeDualLayerTx(rec.id)
      }
    } catch {
      // leave orphaned
    }
  }

  return result
}
