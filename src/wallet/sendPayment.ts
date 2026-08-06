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
import { assertOnlineForPayment } from './paymentPolicy'
import {
  prepareSpendHeal,
  runExclusiveSpend,
  assertSendableBalance,
  refreshSpendableBalance,
} from './spendGuard'
import { scheduleHistoryBackupPush } from './deviceSync'
import { isAlreadySpentInputError, releaseStaleSpendableOutputs } from './staleOutputRelease'

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
        // `acceptDelayedBroadcast` defaults to TRUE in the SDK, which queues the
        // transaction for the monitor's TaskSendWaiting loop instead of sending
        // it here — and in delayed mode the toolbox deliberately does not throw
        // on a failed broadcast. A send that only reached local storage then
        // looks identical to one that reached a miner. The user is standing in
        // front of this, so it goes out now and a failure is an error.
        // Collectable sends have always done this; payments were the odd one out.
        options: {
          acceptDelayedBroadcast: false,
          signAndProcess: true,
        },
      })

      const realTxid = (result as { txid?: string })?.txid
      const txid = realTxid ?? `local-${Date.now().toString(16)}`
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

      // Pre-send heal already ran; background poll + settle grace reconcile the rest.
      const balanceSats = Math.max(0, (await fetchBalanceSats(active.wallet).catch(() => 0)) || 0)
      return { txid, balanceSats }
    } catch (err) {
      clearPendingSend(pending.id)
      // The network rejecting an input is the only proof our spendable set is
      // stale. Clear those outputs now so the next attempt picks live coins.
      if (isAlreadySpentInputError(err)) await releaseStaleSpendableOutputs()
      throw err
    }
  })
}
