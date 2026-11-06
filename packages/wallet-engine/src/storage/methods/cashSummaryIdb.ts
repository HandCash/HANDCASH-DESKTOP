import type { StorageIdb } from '../StorageIdb'
import type { StorageIdbSchema } from '../schema/StorageIdbSchema'
import type { IDBPObjectStore } from 'idb'
import { isAutoSpendableChangeOutput } from './managedChange'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'

/** Seek status index keys without copying BEEF bodies or all transaction IDs. */
export async function outputTransactionEligible(
  store: IDBPObjectStore<StorageIdbSchema, string[], 'transactions', 'readonly' | 'readwrite'>,
  transactionId: number,
  statuses: string[],
  userId?: number,
): Promise<boolean> {
  for (const status of statuses) {
    const index = userId == null ? store.index('status') : store.index('status_userId')
    const key = userId == null ? status : [status, userId]
    let cursor = await index.openKeyCursor(IDBKeyRange.only(key))
    if (cursor && Number(cursor.primaryKey) < transactionId) {
      cursor = await cursor.continuePrimaryKey(key, transactionId)
    }
    if (cursor && Number(cursor.primaryKey) === transactionId) return true
  }
  return false
}

export type CashSummary = { sats: number; outputCount: number; rowCount: number }
export type CashSummaryPage = CashSummary & { next: number | null; revision: number }

/**
 * Display projection only. BRC-100 spend paths still use the authoritative
 * balance operation. Read at most 100 physical output rows, by primary key:
 * neither a shrinking spendable set nor a large offset can skip/repeat coins.
 * No network, script hydration, whole-table count or getAllKeys.
 */
export async function readCashSummaryPageIdb(
  storage: StorageIdb,
  identityKey: string,
  after: number
): Promise<Omit<CashSummaryPage, 'revision'>> {
  if (!Number.isSafeInteger(after) || after < 0) throw new WERR_INVALID_OPERATION('Invalid summary cursor')
  const tx = storage.toDbTrx(['users', 'outputs', 'transactions', 'output_baskets'], 'readonly')
  const user = await tx.objectStore('users').index('identityKey').get(identityKey)
  if (!user) throw new WERR_INVALID_OPERATION('Summary owner is unavailable')
  const basket = await tx.objectStore('output_baskets').index('name_userId').get(['default', user.userId])
  const rows = await tx.objectStore('outputs').getAll(IDBKeyRange.lowerBound(after, true), 100)
  let sats = 0
  let outputCount = 0
  let rowCount = 0
  const statuses = new Map<number, boolean>()
  for (const row of rows) {
    if (row.userId !== user.userId) continue
    rowCount++
    if (!basket || row.basketId !== basket.basketId || !isAutoSpendableChangeOutput(row)) continue
    let eligible = statuses.get(row.transactionId)
    if (eligible == null) {
      eligible = await outputTransactionEligible(
        tx.objectStore('transactions'), row.transactionId,
        ['completed', 'unproven', 'nosend', 'sending'], user.userId,
      )
      statuses.set(row.transactionId, eligible)
    }
    if (!eligible) continue
    sats += row.satoshis
    outputCount++
  }
  await tx.done
  if (!Number.isSafeInteger(sats) || sats < 0) throw new WERR_INVALID_OPERATION('Invalid summary amount')
  return { sats, outputCount, rowCount, next: rows.length === 100 ? rows[rows.length - 1]!.outputId : null }
}
