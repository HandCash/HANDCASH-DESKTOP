/**
 * BRC-29 peer payments (HandCash ↔ HandCash).
 *
 * Thin path mirroring `@bsv/sdk` Brc29RemittanceModule — no RemittanceManager
 * invoice/receipt threads. Sender derives a payee key, locks P2PKH, broadcasts
 * via createAction; remittance rides the tip/pay-sent chat card; payee
 * internalizeAction credits default-basket balance (SPV).
 *
 * Plain identity-address P2PKH stays in sendPayment.ts for external addresses.
 */
import { createNonce, P2PKH, PublicKey } from '@bsv/sdk'
import { createActor } from 'xstate'
import {
  hasActivityTxid,
  recordAppActivity,
  WALLET_ACTIVITY_ORIGIN,
} from './appActivity'
import { getBeefForTxidCached } from './beefCache'
import {
  beginPendingSend,
  clearPendingSend,
  completePendingSend,
} from './pendingSend'
import { fetchBalanceSats, getActiveWallet } from './session'
import { assertOnlineForPayment } from './paymentPolicy'
import {
  prepareSpendHeal,
  runExclusiveSpend,
} from './spendGuard'
import { scheduleHistoryBackupPush } from './deviceSync'
import { isAlreadySpentInputError, releaseStaleSpendableOutputs } from './staleOutputRelease'
import {
  clearPaymentProgress,
  setPaymentProgress,
} from './paymentProgress'
import { bsvSendMachine } from './bsvSendMachine'
import { validateIdentityKey, normalizeIdentityKey } from './friends'
import {
  listMessages,
  listThreads,
  updateMessage,
} from './messageStore'
import { setSyncHealth } from './walletHealth'
import { toastSuccess } from './toast'
import { formatPrimaryFromSats } from './fx'
import { getDisplayCurrency } from './displayCurrency'

/** BRC-29 protocol id — see BRCs/payments/0029.md */
export const BRC29_PROTOCOL_ID: [2, '3241645161d8'] = [2, '3241645161d8']

export type Brc29Remittance = {
  derivationPrefix: string
  derivationSuffix: string
  outputIndex: number
}

export type SendBrc29Result = {
  txid: string
  balanceSats: number
  remittance: Brc29Remittance
}

export type InternalizeBrc29Result = {
  accepted: boolean
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

function alreadyInternalizedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /already (?:spent|imported|internalized|in (?:the )?wallet|ours)/i.test(msg)
}

/**
 * Send sats to a peer identity key using BRC-29 derived P2PKH.
 * Remittance must be delivered out-of-band (tip/pay-sent card) for the payee
 * to internalize — chain custody does not depend on messagebox success.
 */
export async function sendBrc29ToIdentityKey(opts: {
  payeeIdentityKey: string
  satoshis: number
  friendLabel?: string | null
  description?: string
}): Promise<SendBrc29Result> {
  setPaymentProgress('preparing', 'Waiting to send')
  return runExclusiveSpend(
    async () => {
      const chart = createActor(bsvSendMachine).start()
      try {
        assertOnlineForPayment()
        const active = getActiveWallet()
        if (!active) throw new Error('Wallet locked')

        const payee = normalizeIdentityKey(opts.payeeIdentityKey)
        const invalid = validateIdentityKey(payee)
        if (invalid) throw new Error(invalid)

        const satoshis = opts.satoshis
        if (!Number.isFinite(satoshis) || satoshis <= 0) throw new Error('Invalid amount')

        chart.send({ type: 'START', to: payee, satoshis })
        await prepareSpendHeal(satoshis)
        chart.send({ type: 'READY' })

        const pending = beginPendingSend({
          to: payee,
          sats: satoshis,
          friendLabel: opts.friendLabel ?? null,
        })

        try {
          const derivationPrefix = await createNonce(active.wallet, 'self')
          const derivationSuffix = await createNonce(active.wallet, 'self')
          const keyID = `${derivationPrefix} ${derivationSuffix}`
          const { publicKey } = await active.wallet.getPublicKey({
            protocolID: BRC29_PROTOCOL_ID,
            keyID,
            counterparty: payee,
          })
          if (typeof publicKey !== 'string' || !publicKey.trim()) {
            throw new Error('Failed to derive payee public key for BRC-29 payment')
          }

          const address = PublicKey.fromString(publicKey).toAddress(
            active.chain === 'main' ? 'mainnet' : 'testnet',
          )
          const lockingScript = new P2PKH().lock(address).toHex()
          const remittance: Brc29Remittance = {
            derivationPrefix,
            derivationSuffix,
            outputIndex: 0,
          }

          setPaymentProgress(
            'broadcasting',
            'Signing and broadcasting your payment',
          )
          const result = await active.wallet.createAction({
            description:
              opts.description ??
              `HandCash BRC-29 send${opts.friendLabel ? ` to ${opts.friendLabel}` : ''}`,
            labels: ['brc29', 'handcash-send'],
            outputs: [
              {
                lockingScript,
                satoshis,
                outputDescription: 'BRC-29 payment',
                customInstructions: JSON.stringify({
                  derivationPrefix,
                  derivationSuffix,
                  payee,
                }),
              },
            ],
            options: {
              randomizeOutputs: false,
              acceptDelayedBroadcast: true,
              signAndProcess: true,
            },
          })

          const realTxid = (result as { txid?: string })?.txid
          const txid = realTxid ?? `local-${Date.now().toString(16)}`
          const sendWith = (
            result as { sendWithResults?: Array<{ status?: string }> }
          ).sendWithResults
          const { sendWithHasFailure } = await import('./actionReview')
          if (sendWithHasFailure(sendWith) || !realTxid) {
            const { formatReviewActionsError, recoverFromReviewActions } =
              await import('./actionReview')
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
          chart.send({ type: 'BROADCASTED', txid })
          completePendingSend(pending.id, txid)

          const recipientNote = opts.friendLabel
            ? `${opts.friendLabel} (${payee.slice(0, 10)}…)`
            : payee.slice(0, 18)
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
          return { txid, balanceSats, remittance }
        } catch (err) {
          clearPendingSend(pending.id)
          if (isAlreadySpentInputError(err)) await releaseStaleSpendableOutputs()
          const {
            isReviewActionsError,
            formatReviewActionsError,
            recoverFromReviewActions,
          } = await import('./actionReview')
          if (isReviewActionsError(err)) {
            await recoverFromReviewActions({ err, active })
            const message = formatReviewActionsError(err)
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
        if (
          !chart.getSnapshot().matches('failed') &&
          !chart.getSnapshot().matches('done')
        ) {
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

/**
 * Credit a BRC-29 payment into default-basket balance via internalizeAction.
 * Fetches AtomicBEEF by txid when `tx` is omitted.
 */
export async function internalizeBrc29Payment(opts: {
  txid: string
  remittance: Brc29Remittance
  senderIdentityKey: string
  /** Optional AtomicBEEF bytes; otherwise fetched via SPV services. */
  tx?: number[]
  satoshis?: number
}): Promise<InternalizeBrc29Result> {
  const id = opts.txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) {
    return { accepted: false, satoshis: 0, balanceSats: null, reason: 'invalid-txid' }
  }

  const sender = normalizeIdentityKey(opts.senderIdentityKey)
  if (validateIdentityKey(sender)) {
    return {
      accepted: false,
      satoshis: 0,
      balanceSats: null,
      reason: 'invalid-sender',
    }
  }

  const prefix = opts.remittance.derivationPrefix?.trim()
  const suffix = opts.remittance.derivationSuffix?.trim()
  if (!prefix || !suffix) {
    return {
      accepted: false,
      satoshis: 0,
      balanceSats: null,
      reason: 'missing-remittance',
    }
  }

  const outputIndex =
    Number.isInteger(opts.remittance.outputIndex) && opts.remittance.outputIndex >= 0
      ? opts.remittance.outputIndex
      : 0

  const active = getActiveWallet()
  if (!active) {
    return { accepted: false, satoshis: 0, balanceSats: null, reason: 'locked' }
  }

  markInboundPaymentStatus(id, 'Receiving…')
  setSyncHealth({
    phase: 'syncing',
    message: 'Importing BRC-29 payment (SPV)',
  })

  try {
    let atomic = opts.tx
    if (!atomic || atomic.length === 0) {
      const beef = await getBeefForTxidCached(active, id)
      atomic = beef.toBinaryAtomic(id)
    }

    await active.wallet.internalizeAction({
      tx: atomic,
      description: 'BRC-29 payment received',
      labels: ['brc29'],
      outputs: [
        {
          outputIndex,
          protocol: 'wallet payment',
          paymentRemittance: {
            derivationPrefix: prefix,
            derivationSuffix: suffix,
            senderIdentityKey: sender,
          },
        },
      ],
      seekPermission: false,
    })

    const satoshis =
      typeof opts.satoshis === 'number' && opts.satoshis > 0
        ? Math.floor(opts.satoshis)
        : 0

    if (satoshis > 0 && !hasActivityTxid(id, 'earned')) {
      recordAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'earned',
        sats: satoshis,
        method: 'receive',
        note: 'Received coins',
        txid: id,
      })
    }

    scheduleHistoryBackupPush('internalizeAction')
    const balanceSats = await fetchBalanceSats(active.wallet).catch(() => null)

    markInboundPaymentStatus(id, 'Received')
    const amountLabel =
      satoshis > 0
        ? formatPrimaryFromSats(satoshis, getDisplayCurrency())
        : undefined
    toastSuccess('Payment received', amountLabel)
    setSyncHealth({ phase: 'ok', message: null })
    return { accepted: true, satoshis, balanceSats }
  } catch (err) {
    if (alreadyInternalizedError(err)) {
      const balanceSats = await fetchBalanceSats(active.wallet).catch(() => null)
      markInboundPaymentStatus(id, 'Received')
      setSyncHealth({ phase: 'ok', message: null })
      return {
        accepted: true,
        satoshis: 0,
        balanceSats,
        reason: 'already-imported',
      }
    }
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[brc29] internalize failed', id, msg)
    markInboundPaymentStatus(id, 'Verifying on chain…')
    setSyncHealth({ phase: 'ok', message: null })
    return { accepted: false, satoshis: 0, balanceSats: null, reason: msg }
  }
}

export type PaymentTipHint = {
  txid: string
  senderIdentityKey?: string
  satoshis?: number
  brc29?: Brc29Remittance
}

/**
 * Chase tip/pay hints: BRC-29 remittance first, legacy address-P2PKH SPV second.
 */
export async function ingestPaymentsFromTipHints(
  hints: Array<string | PaymentTipHint>,
): Promise<{ imported: number; balanceSats: number | null }> {
  const normalized: PaymentTipHint[] = []
  for (const h of hints) {
    if (typeof h === 'string') {
      const txid = h.trim().toLowerCase()
      if (/^[0-9a-f]{64}$/.test(txid)) normalized.push({ txid })
      continue
    }
    const txid = (h.txid || '').trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(txid)) continue
    normalized.push({
      txid,
      senderIdentityKey: h.senderIdentityKey,
      satoshis: h.satoshis,
      brc29: h.brc29,
    })
  }

  const unique = new Map<string, PaymentTipHint>()
  for (const h of normalized) {
    const prev = unique.get(h.txid)
    if (!prev || (h.brc29 && !prev.brc29)) unique.set(h.txid, h)
  }

  let imported = 0
  let balanceSats: number | null = null

  for (const hint of unique.values()) {
    if (
      hint.brc29?.derivationPrefix &&
      hint.brc29?.derivationSuffix &&
      hint.senderIdentityKey
    ) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const result = await internalizeBrc29Payment({
          txid: hint.txid,
          remittance: {
            derivationPrefix: hint.brc29.derivationPrefix,
            derivationSuffix: hint.brc29.derivationSuffix,
            outputIndex: hint.brc29.outputIndex ?? 0,
          },
          senderIdentityKey: hint.senderIdentityKey,
          satoshis: hint.satoshis,
        })
        if (result.balanceSats != null) balanceSats = result.balanceSats
        if (result.accepted) {
          imported += 1
          break
        }
        if (attempt < 5) await new Promise((r) => setTimeout(r, 1_000))
      }
      continue
    }

    // Legacy: tip without remittance — identity-address SPV sweep.
    const { ingestPaymentByTxid } = await import('./ingestPaymentByTxid')
    for (let attempt = 0; attempt < 6; attempt++) {
      const result = await ingestPaymentByTxid(hint.txid)
      if (result.balanceSats != null) balanceSats = result.balanceSats
      if (result.imported > 0 || result.reason === 'already-imported') {
        imported += Math.max(
          result.imported,
          result.reason === 'already-imported' ? 1 : 0,
        )
        break
      }
      if (attempt < 5) await new Promise((r) => setTimeout(r, 1_000))
    }
  }

  return { imported, balanceSats }
}
