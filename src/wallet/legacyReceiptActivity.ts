/**
 * Activity rows for coins and collectables pulled in from an outside address.
 *
 * Shared by the own-address ingest (Refresh) and the imported-phrase sweep.
 * A sweep that lands on chain but never writes a row looks to the user exactly
 * like a sweep that silently did nothing, so every path that moves value in
 * records it here rather than keeping a private copy.
 */
import {
  hasSettledActivityItemOutpoint,
  hasSettledActivityTxid,
  IMPORTED_COLLECTABLE_NOTE,
  upsertAppActivity,
  WALLET_ACTIVITY_ORIGIN,
} from './appActivity'
import { itemMigrateTxDescription, noteJobTxids } from './activityJobIndex'
import { noteOwnLedgerRows, scheduleActivityLedgerRefresh } from './activityLedger'
import type { ActivityEntry } from './appActivity'
import { contentUrlForOrigin } from './oneSatImport'
import type { LegacyFundingReceipt } from './legacyScan'
import type { Chain } from './vault'

/** Activity rows for newly swept funding — one per incoming payment txid. */
export function recordFundingReceipts(receipts: LegacyFundingReceipt[]): void {
  const byTx = new Map<string, number>()
  for (const receipt of receipts) {
    const txid = receipt.receiveTxid.trim().toLowerCase()
    if (!txid || !(receipt.satoshis > 0)) continue
    byTx.set(txid, (byTx.get(txid) ?? 0) + receipt.satoshis)
  }
  for (const [txid, sats] of byTx) {
    if (hasSettledActivityTxid(txid, 'earned', { item: false })) continue
    upsertAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'earned',
      sats,
      method: 'receive',
      note: 'Received coins',
      txid,
      status: 'complete',
    })
  }
}

export type MigratedItemReceipt = {
  /** Source outpoint on the foreign address. */
  outpoint: string
  origin: string
  /** Transaction that moved the tip to this wallet. */
  sweepTxid: string
  /** Output of {@link sweepTxid} now holding the tip. */
  sweepVout?: number
  name?: string | null
}

/**
 * Activity for collectables migrated in from an imported phrase.
 *
 * A `groupId` (a wallet job's id) folds the whole run into one record. Its
 * legs are the wallet ledger's own: each migrate output carries the origin and
 * name it was filed with, and the job index names the run. Writing a stored
 * row per item as well re-encoded the whole Activity store a hundred times per
 * transaction and, at thousands of items, pushed every older record out of it.
 * The legs go into the ledger's saved copy as they land, so a restart before
 * the next live read still shows them.
 */
export function recordMigratedItemActivity(
  items: MigratedItemReceipt[],
  chain: Chain,
  opts?: { groupId?: string | null },
): void {
  const groupId = opts?.groupId?.trim()
  if (groupId) {
    noteJobTxids(groupId, items.map((item) => item.sweepTxid))
    noteOwnLedgerRows(migrateLedgerRows(items))
    scheduleActivityLedgerRefresh()
    return
  }
  for (const item of items) {
    const op = item.outpoint.trim().toLowerCase()
    if (!op || hasSettledActivityItemOutpoint(op)) continue
    const origin = item.origin.trim() || op.replace(/\.(\d+)$/, '_$1')
    upsertAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'earned',
      sats: 1,
      method: 'receive-collectable',
      note: IMPORTED_COLLECTABLE_NOTE,
      txid: item.sweepTxid.trim().toLowerCase() || undefined,
      status: 'complete',
      item: {
        name: item.name?.trim() || 'Collectable',
        origin,
        outpoint: op,
        imageUrl: contentUrlForOrigin(origin, chain),
      },
    })
  }
}

const TXID = /^[0-9a-f]{64}$/
const ORIGIN = /^[0-9a-f]{64}[._]\d+$/

/**
 * The rows a ledger read will produce for these migrate outputs: one per tip
 * at its new output, noted with the transaction's own description. A receipt
 * without its output (a tip an earlier transaction already moved) is left to
 * the read.
 */
export function migrateLedgerRows(items: readonly MigratedItemReceipt[]): ActivityEntry[] {
  const byTx = new Map<string, Array<MigratedItemReceipt & { sweepVout: number }>>()
  for (const item of items) {
    const txid = item.sweepTxid.trim().toLowerCase()
    const vout = item.sweepVout
    if (!TXID.test(txid) || vout == null || !Number.isSafeInteger(vout) || vout < 0) continue
    const legs = byTx.get(txid) ?? []
    legs.push({ ...item, sweepVout: vout })
    byTx.set(txid, legs)
  }
  const at = Date.now()
  const rows: ActivityEntry[] = []
  for (const [txid, legs] of byTx) {
    const note = itemMigrateTxDescription(legs.length, legs[0]!.outpoint)
    for (const leg of legs) {
      const outpoint = `${txid}.${leg.sweepVout}`
      const filed = leg.origin.trim().toLowerCase()
      rows.push({
        id: `ledger:${txid}:${outpoint}`,
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'earned',
        sats: 1,
        at,
        method: 'receive-collectable',
        note,
        txid,
        item: {
          name: leg.name?.trim().slice(0, 80) || 'Collectable',
          origin: ORIGIN.test(filed) ? filed.replace('.', '_') : `${txid}_${leg.sweepVout}`,
          outpoint,
        },
      })
    }
  }
  return rows
}
