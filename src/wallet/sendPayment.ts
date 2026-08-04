import { P2PKH } from '@bsv/sdk'
import {
  hasActivityTxid,
  recordAppActivity,
  WALLET_ACTIVITY_ORIGIN,
} from './appActivity'
import {
  beginPendingSend,
  clearPendingSend,
  completePendingSend,
} from './pendingSend'
import { resolvePaymentAddress } from './friends'
import { fetchBalanceSats, getActiveWallet } from './session'
import { refreshFromChain } from './chainIngest'
import { assertOnlineForPayment } from './paymentPolicy'
import {
  prepareSpendHeal,
  runExclusiveSpend,
  assertSendableBalance,
  refreshSpendableBalance,
} from './spendGuard'
import { scheduleHistoryBackupPush } from './deviceSync'

export type SendSatsResult = {
  txid: string
  balanceSats: number
}

export { assertSendableBalance, refreshSpendableBalance }

/** Broadcast a P2PKH payment from the active wallet. */
export async function sendSatsToAddress(opts: {
  to: string
  satoshis: number
  friendLabel?: string | null
  description?: string
}): Promise<SendSatsResult> {
  return runExclusiveSpend(async () => {
    assertOnlineForPayment()
    const active = getActiveWallet()
    if (!active) throw new Error('Wallet locked')

    const to = resolvePaymentAddress(opts.to, active.chain)
    const satoshis = opts.satoshis
    if (!Number.isFinite(satoshis) || satoshis <= 0) throw new Error('Invalid amount')

    await prepareSpendHeal(satoshis)

    const pending = beginPendingSend({
      to,
      sats: satoshis,
      friendLabel: opts.friendLabel ?? null,
    })

    try {
      const lockingScript = new P2PKH().lock(to).toHex()
      const result = await active.wallet.createAction({
        description: opts.description ?? `HandCash send to ${to}`,
        labels: ['handcash-send'],
        outputs: [
          {
            lockingScript,
            satoshis,
            outputDescription: 'Payment',
          },
        ],
      })

      const txid =
        (result as { txid?: string })?.txid ?? `local-${Date.now().toString(16)}`
      completePendingSend(pending.id, txid)

      const recipientNote = opts.friendLabel ? `${opts.friendLabel} (${to})` : to
      if (!hasActivityTxid(txid)) {
        recordAppActivity({
          origin: WALLET_ACTIVITY_ORIGIN,
          kind: 'spent',
          sats: satoshis,
          method: 'send',
          note: `Sent to ${recipientNote}`,
          txid,
        })
      }
      clearPendingSend(pending.id)

      scheduleHistoryBackupPush('send')

      let balanceSats = Math.max(0, (await fetchBalanceSats(active.wallet).catch(() => 0)) || 0)
      try {
        const synced = await refreshFromChain({ announceReceive: false })
        if (synced != null) balanceSats = synced
        else balanceSats = await fetchBalanceSats(active.wallet)
      } catch {
        // keep optimistic / last fetch
      }

      return { txid, balanceSats }
    } catch (err) {
      clearPendingSend(pending.id)
      throw err
    }
  })
}
