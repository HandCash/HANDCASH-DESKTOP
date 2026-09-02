import { P2PKH } from '@bsv/sdk'
import { createActor } from 'xstate'
import {
  hasActivityTxid,
  noteOutboundSendComplete,
  noteOutboundSendPending,
  failOutboundSendPending,
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
import {
  describeInsufficientFunds,
  isInsufficientFundsError,
} from './insufficientFunds'
import { assertOnlineForPayment } from './paymentPolicy'
import {
  prepareSpendHeal,
  runExclusiveSpend,
  assertSendableBalance,
  assertSendableBalanceForReview,
  refreshSpendableBalance,
} from './spendGuard'
import { scheduleHistoryBackupPush } from './deviceSync'
import {
  isAlreadySpentInputError,
  onAlreadySpentSend,
  sealSpentInputsOfSignedTx,
} from './staleOutputRelease'
import {
  clearPaymentProgress,
  setPaymentProgress,
} from './paymentProgress'
import { bsvSendMachine } from './bsvSendMachine'
import {
  beginDualLayerSend,
  failDualLayerSend,
  noteDualLayerPostBeef,
  noteDualLayerTxid,
  tryFinalizeDualLayerTx,
} from './dualLayerSend'
import { transitionTx } from './txStore'
import { spendBlockedMessage } from './walletCoordinator'

export type SendSatsResult = {
  txid: string
  balanceSats: number
}


export { assertSendableBalance, assertSendableBalanceForReview, refreshSpendableBalance }

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
          const { releaseStuckNosends, releaseUnsignedSpendReservations } =
            await import('./actionReview')
          await releaseStuckNosends(active)
          await releaseUnsignedSpendReservations(active)
          await prepareSpendHeal(satoshis)

          const availableSats = await fetchBalanceSats(active.wallet).catch(() => 0)
          const dual = beginDualLayerSend({
            satoshis,
            availableSats: availableSats || 0,
            to,
            // Toolbox createAction owns input selection + reservation.
            skipSoftLock: true,
          })
          if (!dual.ok) {
            chart.send({ type: 'FAIL', error: dual.detail })
            throw new Error(dual.detail)
          }
          const dualId = dual.record.id

          chart.send({ type: 'READY' })

          let signedTxid: string | undefined
          let signedAtomic: number[] | undefined
          try {
            const lockingScript = new P2PKH().lock(to).toHex()
            setPaymentProgress(
              'broadcasting',
              'Signing and broadcasting your payment',
            )
            const createActionArgs = {
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
            }
            let result: Awaited<ReturnType<typeof active.wallet.createAction>>
            try {
              result = await active.wallet.createAction(createActionArgs)
            } catch (firstErr) {
              const { isIteratorCrashError, isReviewActionsError, recoverFromReviewActions } =
                await import('./actionReview')
              if (!isIteratorCrashError(firstErr) && !isReviewActionsError(firstErr)) {
                throw firstErr
              }
              console.warn(
                '[send] createAction poison — repairing and retrying once',
                firstErr instanceof Error ? firstErr.message : String(firstErr),
              )
              await recoverFromReviewActions({ err: firstErr, active })
              result = await active.wallet.createAction(createActionArgs)
            }

            const realTxid = (result as { txid?: string })?.txid
            signedTxid = realTxid
            const txid = realTxid ?? `local-${Date.now().toString(16)}`
            if (realTxid) noteDualLayerTxid(dualId, realTxid)
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
              failDualLayerSend(dualId, 'ARC_REJECTED', 'sendWith failure')
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
            if (atomic?.length && realTxid) {
              signedAtomic = atomic
              // Retire the consumed coins before the next send can pick them —
              // chain-ingest's rehide pass defers while a spend is queued.
              await sealSpentInputsOfSignedTx(realTxid, atomic)
              // Signed tx is spent for UI — miner ACK is best-effort background work.
              transitionTx(dualId, 'SEEN_IN_MEMPOOL')
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

              void (async () => {
                try {
                  const { submitAtomicBeefToMiners } = await import('./minerSubmit')
                  const miner = await submitAtomicBeefToMiners(realTxid, atomic)
                  if (miner.summary) noteDualLayerPostBeef(dualId, miner.summary)
                  void tryFinalizeDualLayerTx(dualId).catch((err) => {
                    console.warn('[send] SPV finality deferred', realTxid, err)
                  })
                } catch (err) {
                  failDualLayerSend(
                    dualId,
                    'UNKNOWN',
                    err instanceof Error ? err.message : String(err),
                    { hideInputs: isAlreadySpentInputError(err) },
                  )
                  void import('./minerSubmit').then(({ reportLateMinerSubmitFailure }) =>
                    reportLateMinerSubmitFailure({
                      pendingId: pending.id,
                      txid: realTxid,
                      reason: err,
                    }),
                  )
                }
              })()

              const balanceSats = Math.max(
                0,
                (await fetchBalanceSats(active.wallet).catch(() => 0)) || 0,
              )
              return { txid, balanceSats }
            } else if (realTxid) {
              // createAction broadcast without confirm postBeef — still mark mempool-seen.
              transitionTx(dualId, 'SEEN_IN_MEMPOOL')
              void tryFinalizeDualLayerTx(dualId).catch((err) => {
                console.warn('[send] SPV finality deferred', realTxid, err)
              })
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
            failDualLayerSend(
              dualId,
              'UNKNOWN',
              err instanceof Error ? err.message : String(err),
              { hideInputs: isAlreadySpentInputError(err) },
            )
            if (isAlreadySpentInputError(err)) {
              await onAlreadySpentSend({ txid: signedTxid, atomic: signedAtomic })
            }
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
                await onAlreadySpentSend({ txid: signedTxid, atomic: signedAtomic })
              }
              const message = formatReviewActionsError(err)
              console.warn('[send] failed', message, err)
              chart.send({ type: 'FAIL', error: message })
              throw new Error(message)
            }
            if (isInsufficientFundsError(err)) {
              const message = await describeInsufficientFunds(
                active.wallet,
                satoshis,
              )
              console.warn('[send] insufficient funds', message, err)
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
    failOutboundSendPending({
      pendingId: pending.id,
      reason: err instanceof Error ? err.message : String(err),
    })
    const blocked = spendBlockedMessage(err)
    if (blocked) throw new Error(blocked)
    throw err
  }
}
