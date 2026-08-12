/**
 * SPV-first funding ingest from a known payment txid (DM tip / pay-sent).
 *
 * Pattern mirrors soft-latch item receive: messagebox is the wake-up (grade B);
 * we fetch BEEF, prove the outs that pay us, and sweep into managed change
 * (grade A). Address-index polling is only a fallback / secondary verify.
 */
import { getBeefForTxidCached } from './beefCache'
import {
  hasActivityTxid,
  recordAppActivity,
  WALLET_ACTIVITY_ORIGIN,
} from './appActivity'
import { importLegacyUtxos, type LegacyUtxo } from './legacyScan'
import { isLatchDustSats } from './oneSatLatch'
import { scriptPaysAddress } from './ordinalOwnership'
import { fetchBalanceSats, getActiveWallet } from './session'
import { setSyncHealth } from './walletHealth'
import { toastSuccess } from './toast'
import { formatPrimaryFromSats } from './fx'
import { getDisplayCurrency } from './displayCurrency'
import { updateMessage, listMessages, listThreads } from './messageStore'

export type IngestPaymentByTxidResult = {
  imported: number
  satoshis: number
  balanceSats: number | null
  reason?: string
}

function markInboundPaymentStatus(txid: string, status: string): void {
  const id = txid.trim().toLowerCase()
  if (!id) return
  try {
    for (const thread of listThreads()) {
        for (const msg of listMessages(thread.peerId)) {
        if (msg.direction !== 'in') continue
        if (msg.kind !== 'tip' && msg.kind !== 'pay-sent') continue
        if ((msg.meta?.txid || '').trim().toLowerCase() !== id) continue
        updateMessage(msg.id, { meta: { status } })
      }
    }
  } catch {
    /* chat UI is optional */
  }
}

/**
 * Given a payment txid from a tip/pay card, SPV-prove and sweep outs that pay
 * this wallet. Returns how many outs were imported.
 */
export async function ingestPaymentByTxid(
  txid: string,
): Promise<IngestPaymentByTxidResult> {
  const id = txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) {
    return { imported: 0, satoshis: 0, balanceSats: null, reason: 'invalid-txid' }
  }

  const active = getActiveWallet()
  if (!active) {
    return { imported: 0, satoshis: 0, balanceSats: null, reason: 'locked' }
  }

  markInboundPaymentStatus(id, 'Receiving (SPV)')
  setSyncHealth({
    phase: 'syncing',
    message: 'Importing payment (SPV)',
  })

  try {
    const beef = await getBeefForTxidCached(active, id)
    const tx = beef.findTxid(id)?.tx
    if (!tx) {
      markInboundPaymentStatus(id, 'Waiting for proof…')
      return { imported: 0, satoshis: 0, balanceSats: null, reason: 'beef-missing-tx' }
    }

    const funding: LegacyUtxo[] = []
    for (let vout = 0; vout < tx.outputs.length; vout++) {
      const out = tx.outputs[vout]
      if (!out) continue
      const sats = Number(out.satoshis ?? 0)
      if (!(sats > 1) || isLatchDustSats(sats)) continue
      const lockHex = out.lockingScript?.toHex?.() ?? ''
      if (!scriptPaysAddress(lockHex, active.address)) continue
      funding.push({
        outpoint: `${id}.${vout}`,
        txid: id,
        vout,
        satoshis: sats,
      })
    }

    if (funding.length === 0) {
      markInboundPaymentStatus(id, 'Waiting for funds…')
      return { imported: 0, satoshis: 0, balanceSats: null, reason: 'no-our-funding' }
    }

    const result = await importLegacyUtxos(funding, active)
    const satoshis = result.importedReceipts.reduce((n, r) => n + r.satoshis, 0)

    for (const receipt of result.importedReceipts) {
      const receiveTxid = receipt.receiveTxid.trim().toLowerCase()
      if (!receiveTxid || !(receipt.satoshis > 0)) continue
      if (hasActivityTxid(receiveTxid, 'earned')) continue
      recordAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'earned',
        sats: receipt.satoshis,
        method: 'receive',
        note: 'Received coins',
        txid: receiveTxid,
      })
    }

    const balanceSats = await fetchBalanceSats(active.wallet).catch(() => null)

    if (result.imported > 0) {
      markInboundPaymentStatus(id, 'Received')
      const amountLabel =
        satoshis > 0 ? formatPrimaryFromSats(satoshis, getDisplayCurrency()) : undefined
      toastSuccess('Payment received', amountLabel)
      setSyncHealth({ phase: 'ok', message: null })
      return { imported: result.imported, satoshis, balanceSats }
    }

    // Already swept earlier — still a success for the card.
    if (result.skippedKnown > 0 && result.failed === 0) {
      markInboundPaymentStatus(id, 'Received')
      setSyncHealth({ phase: 'ok', message: null })
      return {
        imported: 0,
        satoshis: 0,
        balanceSats,
        reason: 'already-imported',
      }
    }

    markInboundPaymentStatus(id, 'Verifying on chain…')
    return {
      imported: 0,
      satoshis: 0,
      balanceSats,
      reason: result.errors[0] || 'sweep-failed',
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[payment-spv] ingest failed', id, msg)
    markInboundPaymentStatus(id, 'Verifying on chain…')
    setSyncHealth({ phase: 'ok', message: null })
    return { imported: 0, satoshis: 0, balanceSats: null, reason: msg }
  }
}

