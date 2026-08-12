import { Beef, P2PKH } from '@bsv/sdk'
import { createActor } from 'xstate'
import {
  hasActivityTxid,
  noteOutboundSendComplete,
  noteOutboundSendPending,
  clearOutboundSendPending,
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
  const satoshis = opts.satoshis
  if (!Number.isFinite(satoshis) || satoshis <= 0) throw new Error('Invalid amount')

  setPaymentProgress('preparing', 'Waiting to send')
  // Pin Activity "Sending…" before heal / createAction so Back still shows it.
  const pending = beginPendingSend({
    to: opts.to,
    sats: satoshis,
    friendLabel: opts.friendLabel ?? null,
  })
  noteOutboundSendPending({
    pendingId: pending.id,
    sats: satoshis,
    to: opts.to,
    friendLabel: opts.friendLabel ?? null,
  })

  try {
    return await runExclusiveSpend(
      async () => {
        const chart = createActor(bsvSendMachine).start()
        try {
          assertOnlineForPayment()
          const active = getActiveWallet()
          if (!active) throw new Error('Wallet locked')

          const to = await resolvePaymentRecipient(opts.to, active.chain)
          noteOutboundSendPending({
            pendingId: pending.id,
            sats: satoshis,
            to,
            friendLabel: opts.friendLabel ?? null,
          })

          chart.send({ type: 'START', to, satoshis })
          const { releaseStuckNosends } = await import('./actionReview')
          await releaseStuckNosends(active)
          await prepareSpendHeal(satoshis)
          chart.send({ type: 'READY' })

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
                // Delayed + activity only after txid; undelayed throws WERR_REVIEW_ACTIONS
                // on prior ghost conflicts ("require review").
                acceptDelayedBroadcast: true,
                signAndProcess: true,
              },
            })

            const realTxid = (result as { txid?: string })?.txid
            const txid = realTxid ?? `local-${Date.now().toString(16)}`
            const sendWith = (result as { sendWithResults?: Array<{ status?: string }> })
              .sendWithResults
            const { sendWithHasFailure } = await import('./actionReview')
            if (sendWithHasFailure(sendWith) || !realTxid) {
              const { formatReviewActionsError, recoverFromReviewActions } = await import(
                './actionReview'
              )
              await recoverFromReviewActions({
                err: {
                  name: 'WERR_REVIEW_ACTIONS',
                  sendWithResults: sendWith,
                  txid: realTxid,
                },
                active,
              })
              throw new Error(
                formatReviewActionsError({
                  sendWithResults: sendWith,
                  reviewActionResults: [],
                }),
              )
            }
            const rawTx = (result as { tx?: unknown }).tx
            const atomic =
              Array.isArray(rawTx) && rawTx.every((n) => typeof n === 'number')
                ? (rawTx as number[])
                : rawTx instanceof Uint8Array
                  ? Array.from(rawTx)
                  : undefined
            if (atomic?.length && active.services?.postBeef) {
              setPaymentProgress('broadcasting', 'Confirming payment on the network')
              const { summarizePostBeef, formatPostBeefFailure } = await import(
                './postBeefResult'
              )
              let summary
              try {
                const results = await active.services.postBeef(
                  Beef.fromBinary(atomic),
                  [realTxid],
                )
                summary = summarizePostBeef(results as never)
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                console.warn('[send] postBeef confirm failed', realTxid, msg)
                if (/4022206465|4022206466|beef|mergeRawTx|invalid/i.test(msg)) {
                  throw new Error(
                    'Payment was signed but the transaction body is invalid — try Send again.',
                  )
                }
                throw new Error(
                  'Could not confirm the payment on the network. Check connection and try again.',
                )
              }
              if (!summary.accepted) {
                if (summary.doubleSpend || summary.missingInputs) {
                  await releaseStaleSpendableOutputs()
                }
                throw new Error(formatPostBeefFailure(summary))
              }
            }
            chart.send({ type: 'BROADCASTED', txid })
            completePendingSend(pending.id, txid)

            const recipientNote = opts.friendLabel ? `${opts.friendLabel} (${to})` : to
            noteOutboundSendComplete({
              pendingId: pending.id,
              txid,
              sats: satoshis,
              to,
              friendLabel: opts.friendLabel ?? null,
            })
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
            clearOutboundSendPending(pending.id)
            if (isAlreadySpentInputError(err)) await releaseStaleSpendableOutputs()
            const {
              isReviewActionsError,
              isIteratorCrashError,
              formatReviewActionsError,
              recoverFromReviewActions,
            } = await import('./actionReview')
            if (isReviewActionsError(err) || isIteratorCrashError(err)) {
              await recoverFromReviewActions({ err, active })
              // Iterator crashes are local toolbox poison — not proof UTXOs are
              // spent. Never bulk-release spendable outputs on that path.
              if (isAlreadySpentInputError(err)) {
                await releaseStaleSpendableOutputs()
              }
              const message = formatReviewActionsError(err)
              console.warn('[send] failed', message, err)
              chart.send({ type: 'FAIL', error: message })
              throw new Error(message)
            }
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
  } catch (err) {
    clearPendingSend(pending.id)
    clearOutboundSendPending(pending.id)
    throw err
  }
}
