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
  upsertAppActivity,
  WALLET_ACTIVITY_ORIGIN,
} from './appActivity'
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
}

/** Activity rows for collectables migrated in from an imported phrase. */
export function recordMigratedItemActivity(
  items: MigratedItemReceipt[],
  chain: Chain,
): void {
  for (const item of items) {
    const op = item.outpoint.trim().toLowerCase()
    if (!op || hasSettledActivityItemOutpoint(op)) continue
    const origin = item.origin.trim() || op.replace(/\.(\d+)$/, '_$1')
    upsertAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'earned',
      sats: 1,
      method: 'receive-collectable',
      note: 'Imported collectable',
      txid: item.sweepTxid.trim().toLowerCase() || undefined,
      status: 'complete',
      item: {
        name: 'Collectable',
        origin,
        outpoint: op,
        imageUrl: contentUrlForOrigin(origin, chain),
      },
    })
  }
}
