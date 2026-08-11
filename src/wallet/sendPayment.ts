import { P2PKH } from '@bsv/sdk'
import { createActor } from 'xstate'
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
import { resolvePaymentRecipient } from './friends'
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
import {
  clearPaymentProgress,
  setPaymentProgress,
} from './paymentProgress'
import { bsvSendMachine } from './bsvSendMachine'

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
  setPaymentProgress('preparing', 'Waiting to send')
  return runExclusiveSpend(
    async () => {
    const chart = createActor(bsvSendMachine).start()
    try {
      assertOnlineForPayment()
      const active = getActiveWallet()
      if (!active) throw new Error('Wallet locked')

      const to = await resolvePaymentRecipient(opts.to, active.chain)
      const satoshis = opts.satoshis
      if (!Number.isFinite(satoshis) || satoshis <= 0) throw new Error('Invalid amount')

      chart.send({ type: 'START', to, satoshis })
      await prepareSpendHeal(satoshis)
      chart.send({ type: 'READY' })

      const pending = beginPendingSend({
        to,
        sats: satoshis,
        friendLabel: opts.friendLabel ?? null,
      })

      try {
        const lockingScript = new P2PKH().lock(to).toHex()
        setPaymentProgress(
          'broadcasting',
          'Signing and broadcasting your payment',
        )
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
          options: {
            acceptDelayedBroadcast: false,
            signAndProcess: true,
          },
        })

        const realTxid = (result as { txid?: string })?.txid
        const txid = realTxid ?? `local-${Date.now().toString(16)}`
        chart.send({ type: 'BROADCASTED', txid })
        completePendingSend(pending.id, txid)

        const recipientNote = opts.friendLabel ? `${opts.friendLabel} (${to})` : to
        if (!hasActivityTxid(txid, 'spent')) {
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

        setPaymentProgress('finishing')
        scheduleHistoryBackupPush('send')

        const balanceSats = Math.max(
          0,
          (await fetchBalanceSats(active.wallet).catch(() => 0)) || 0,
        )
        return { txid, balanceSats }
      } catch (err) {
        clearPendingSend(pending.id)
        if (isAlreadySpentInputError(err)) await releaseStaleSpendableOutputs()
        chart.send({
          type: 'FAIL',
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    } catch (err) {
      if (!chart.getSnapshot().matches('failed') && !chart.getSnapshot().matches('done')) {
        chart.send({
          type: 'FAIL',
          error: err instanceof Error ? err.message : String(err),
        })
      }
      throw err
    } finally {
      chart.stop()
      clearPaymentProgress()
    }
  },
    () => setPaymentProgress('preparing', 'Preparing payment'),
  )
}
