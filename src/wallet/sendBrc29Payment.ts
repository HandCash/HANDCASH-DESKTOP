/**
 * BRC-29 peer payments (HandCash ↔ HandCash) — Babbage / wallet-toolbox shape.
 *
 * One `createAction` broadcasts immediately. Remittance (± inline Atomic BEEF)
 * then goes to the payee inbox. Same-identity internalizes locally and still
 * notifies our box so other devices can ingest. Inbox miss → local outbox retry,
 * never a second payment tx.
 *
 * Plain identity-address P2PKH stays in sendPayment.ts for external addresses.
 */
import { Beef, createNonce, P2PKH, PublicKey } from '@bsv/sdk'
import { createActor } from 'xstate'
import {
  hasActivityTxid,
  hasSettledActivityTxid,
  noteInboundReceiveComplete,
  noteInboundReceivePending,
  noteOutboundSendComplete,
  noteOutboundSendPending,
  clearOutboundSendPending,
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
import { validateIdentityKey, normalizeIdentityKey } from './friends'
import { chooseBrc29SettlePath } from './brc29SettlePath'
import {
  brc29SendMachine,
  mustBrc29DeliverToPeer,
  mustBrc29SelfReceive,
} from './brc29SendMachine'
import { enqueuePendingBrc29Remit } from './pendingBrc29Outbox'
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
  outputIndex?: number
}

export type SendBrc29Result = {
  txid: string
  balanceSats: number
  remittance: Brc29Remittance
  /** Payee was this wallet — internalized + broadcast here. */
  selfReceived?: boolean
  /** Signed Atomic BEEF delivered (or ready to deliver) to the payee. */
  atomicBeef?: number[]
  /** Messagebox accepted the payment envelope (`cloud`), else local-only. */
  peerDelivered?: boolean
}

async function fetchAtomicBeefFromUrl(url: string): Promise<number[] | undefined> {
  try {
    const res = await fetch(url)
    if (!res.ok) return undefined
    const buf = new Uint8Array(await res.arrayBuffer())
    return buf.length > 0 ? Array.from(buf) : undefined
  } catch {
    return undefined
  }
}

/** Payee (or sender fallback) submits the signed payment to the network. */
export async function broadcastAtomicBeef(
  txid: string,
  atomic: number[],
): Promise<boolean> {
  const id = txid.trim().toLowerCase()
  const active = getActiveWallet()
  if (!active || !/^[0-9a-f]{64}$/.test(id) || !atomic.length) return false
  try {
    const { summarizePostBeef } = await import('./postBeefResult')
    const results = await active.services.postBeef(Beef.fromBinary(atomic), [id])
    return summarizePostBeef(results as never).accepted
  } catch (err) {
    console.warn(
      '[brc29] postBeef failed',
      id,
      err instanceof Error ? err.message : String(err),
    )
    return false
  }
}

/**
 * Delayed createAction can return a txid before the network accepts it.
 * Confirm with postBeef before Activity / remittance — otherwise mobile shows
 * "sent" for a doubleSpend that never exists on chain (payee never receives).
 */
async function ensurePaymentBroadcasted(
  txid: string,
  atomic: number[] | undefined,
): Promise<void> {
  const id = txid.trim().toLowerCase()
  if (!atomic?.length) {
    throw new Error(
      'Payment was signed but no transaction body was returned — try Send again.',
    )
  }
  const active = getActiveWallet()
  if (!active?.services?.postBeef) {
    throw new Error('Cannot confirm broadcast offline. Check connection and try again.')
  }
  const { summarizePostBeef, formatPostBeefFailure } = await import('./postBeefResult')
  let summary
  try {
    const beef = Beef.fromBinary(atomic)
    const results = await active.services.postBeef(beef, [id])
    summary = summarizePostBeef(results as never)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[brc29] postBeef confirm failed', id, msg)
    if (/4022206465|4022206466|beef|mergeRawTx|invalid/i.test(msg)) {
      throw new Error(
        'Payment was signed but the transaction body is invalid — try Send again.',
      )
    }
    throw new Error(
      'Could not confirm the payment on the network. Check connection and try again.',
    )
  }
  if (summary.accepted) return
  console.warn('[brc29] broadcast not accepted', id, summary.detail)
  if (summary.doubleSpend || summary.missingInputs) {
    await releaseStaleSpendableOutputs()
  }
  throw new Error(formatPostBeefFailure(summary))
}

function atomicBeefFromCreateAction(result: unknown): number[] | undefined {
  if (!result || typeof result !== 'object') return undefined
  const raw = (result as { tx?: unknown }).tx
  if (Array.isArray(raw) && raw.every((n) => typeof n === 'number')) {
    return raw as number[]
  }
  if (raw instanceof Uint8Array) return Array.from(raw)
  return undefined
}

export type InternalizeBrc29Result = {
  accepted: boolean
  satoshis: number
  balanceSats: number | null
  reason?: string
}

const brc29InternalizeInflight = new Map<string, Promise<InternalizeBrc29Result>>()

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
 * Broadcast a BRC-29 payment (toolbox createAction), then deliver remittance.
 */
export async function sendBrc29ToIdentityKey(opts: {
  payeeIdentityKey: string
  satoshis: number
  friendLabel?: string | null
  description?: string
}): Promise<SendBrc29Result> {
  const satoshis = opts.satoshis
  if (!Number.isFinite(satoshis) || satoshis <= 0) throw new Error('Invalid amount')
  const payeeEarly = normalizeIdentityKey(opts.payeeIdentityKey)

  setPaymentProgress('preparing', 'Waiting to send')
  const pending = beginPendingSend({
    to: payeeEarly,
    sats: satoshis,
    friendLabel: opts.friendLabel ?? null,
  })
  noteOutboundSendPending({
    pendingId: pending.id,
    sats: satoshis,
    to: payeeEarly,
    friendLabel: opts.friendLabel ?? null,
  })

  try {
    return await runExclusiveSpend(
    async () => {
      const chart = createActor(brc29SendMachine).start()
      try {
        assertOnlineForPayment()
        const active = getActiveWallet()
        if (!active) throw new Error('Wallet locked')

        const payee = normalizeIdentityKey(opts.payeeIdentityKey)
        const invalid = validateIdentityKey(payee)
        if (invalid) throw new Error(invalid)

        const settlePath = chooseBrc29SettlePath({
          payeeIdentityKey: payee,
          ourIdentityKey: active.identityKey,
        })
        chart.send({
          type: 'START',
          payee,
          satoshis,
          settlePath,
        })
        const { releaseStuckNosends, sendWithHasFailure } = await import(
          './actionReview'
        )
        await releaseStuckNosends(active)
        await prepareSpendHeal(satoshis)
        chart.send({ type: 'READY' })

        noteOutboundSendPending({
          pendingId: pending.id,
          sats: satoshis,
          to: payee,
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

          setPaymentProgress('broadcasting', 'Signing and broadcasting your payment')
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
              signAndProcess: true,
              acceptDelayedBroadcast: true,
              trustSelf: 'known',
            },
          })

          const realTxid = (result as { txid?: string })?.txid
          const atomicBeef = atomicBeefFromCreateAction(result)
          const sendWith = (result as { sendWithResults?: Array<{ status?: string }> })
            .sendWithResults
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
          const txid = realTxid
          setPaymentProgress('broadcasting', 'Confirming payment on the network')
          await ensurePaymentBroadcasted(txid, atomicBeef)
          chart.send({ type: 'BROADCASTED', txid })

          completePendingSend(pending.id, txid)
          noteOutboundSendComplete({
            pendingId: pending.id,
            txid,
            sats: satoshis,
            to: payee,
            friendLabel: opts.friendLabel ?? null,
          })
          clearPendingSend(pending.id)

          setPaymentProgress('finishing')
          scheduleHistoryBackupPush('send')

          let selfReceived = false
          let peerDelivered = false
          let balanceSats = Math.max(
            0,
            (await fetchBalanceSats(active.wallet).catch(() => 0)) || 0,
          )

          const notifyPayee = async (recipientIdentityKey: string) => {
            const { listFriends } = await import('./friends')
            const { notifyPeerBrc29Payment } = await import('./messageTransport')
            const friend =
              listFriends().find(
                (f) =>
                  f.identityKey.toLowerCase() ===
                  recipientIdentityKey.toLowerCase(),
              ) ?? null
            return notifyPeerBrc29Payment({
              recipientIdentityKey,
              rootKeyHex: active.rootKeyHex,
              senderIdentityKey: active.identityKey,
              messagebox: friend?.messagebox,
              txid,
              satoshis,
              remittance,
              atomicBeef,
              amountLabel: opts.friendLabel ?? undefined,
            })
          }

          if (settlePath.settle === 'selfReceive') {
            if (!mustBrc29SelfReceive(chart.getSnapshot())) {
              chart.send({ type: 'FAIL', error: 'selfReceive expected' })
              throw new Error('brc29SendMachine selfReceive without settle path')
            }
            setPaymentProgress('finishing', 'Crediting payment back to this wallet')
            try {
              await notifyPayee(payee)
            } catch (err) {
              console.warn(
                '[brc29] self inbox notify failed',
                err instanceof Error ? err.message : String(err),
              )
            }
            const claimed = await internalizeBrc29Payment({
              txid,
              remittance,
              senderIdentityKey: payee,
              tx: atomicBeef,
              satoshis,
              announce: false,
            })
            if (claimed.balanceSats != null) balanceSats = claimed.balanceSats
            selfReceived = claimed.accepted
            peerDelivered = selfReceived
            chart.send({ type: 'SETTLED' })
          } else {
            if (!mustBrc29DeliverToPeer(chart.getSnapshot())) {
              chart.send({ type: 'FAIL', error: 'peerNotify expected' })
              throw new Error('brc29SendMachine peerNotify without settle path')
            }
            setPaymentProgress('finishing', 'Notifying recipient')
            const { listFriends } = await import('./friends')
            const friend =
              listFriends().find(
                (f) =>
                  f.identityKey.toLowerCase() ===
                  settlePath.recipientIdentityKey.toLowerCase(),
              ) ?? null
            try {
              const delivered = await notifyPayee(settlePath.recipientIdentityKey)
              peerDelivered = delivered.delivered === 'cloud'
              if (delivered.delivered === 'cloud' && delivered.beefInBox) {
                chart.send({ type: 'BEEF_IN_BOX' })
              } else if (delivered.delivered === 'cloud') {
                chart.send({ type: 'REMIT_IN_BOX' })
              } else {
                chart.send({ type: 'BOX_UNREACHABLE' })
                enqueuePendingBrc29Remit({
                  payeeIdentityKey: settlePath.recipientIdentityKey,
                  senderIdentityKey: active.identityKey,
                  txid,
                  satoshis,
                  remittance,
                  messagebox: friend?.messagebox,
                  amountLabel: opts.friendLabel ?? undefined,
                })
              }
            } catch (err) {
              console.warn(
                '[brc29] peer notify failed',
                err instanceof Error ? err.message : String(err),
              )
              peerDelivered = false
              chart.send({ type: 'BOX_UNREACHABLE' })
              enqueuePendingBrc29Remit({
                payeeIdentityKey: settlePath.recipientIdentityKey,
                senderIdentityKey: active.identityKey,
                txid,
                satoshis,
                remittance,
                messagebox: friend?.messagebox,
                amountLabel: opts.friendLabel ?? undefined,
              })
            }
          }

          return {
            txid,
            balanceSats,
            remittance,
            selfReceived,
            atomicBeef,
            peerDelivered,
          }
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
            // spent. Never releaseSpendable here (that wrote off ~$0.10 of live
            // coins on failed Mobile→Desktop retries).
            if (isAlreadySpentInputError(err)) {
              await releaseStaleSpendableOutputs()
            }
            const message = formatReviewActionsError(err)
            console.warn('[brc29] send failed', message, err)
            chart.send({ type: 'FAIL', error: message })
            throw new Error(message)
          }
          console.warn(
            '[brc29] send failed',
            err instanceof Error ? err.message : String(err),
            err,
          )
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
  } catch (err) {
    clearPendingSend(pending.id)
    clearOutboundSendPending(pending.id)
    throw err
  }
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
  /** Toast “Payment received” (default true). Quiet for same-device self-pay. */
  announce?: boolean
}): Promise<InternalizeBrc29Result> {
  const id = opts.txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) {
    return { accepted: false, satoshis: 0, balanceSats: null, reason: 'invalid-txid' }
  }
  const inflight = brc29InternalizeInflight.get(id)
  if (inflight) return inflight
  const work = internalizeBrc29PaymentOnce(opts)
  brc29InternalizeInflight.set(id, work)
  try {
    return await work
  } finally {
    brc29InternalizeInflight.delete(id)
  }
}

async function internalizeBrc29PaymentOnce(opts: {
  txid: string
  remittance: Brc29Remittance
  senderIdentityKey: string
  tx?: number[]
  satoshis?: number
  announce?: boolean
}): Promise<InternalizeBrc29Result> {
  const id = opts.txid.trim().toLowerCase()

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

  const outputIndexRaw = opts.remittance.outputIndex
  const outputIndex =
    typeof outputIndexRaw === 'number' &&
    Number.isInteger(outputIndexRaw) &&
    outputIndexRaw >= 0
      ? outputIndexRaw
      : 0

  const active = getActiveWallet()
  if (!active) {
    return { accepted: false, satoshis: 0, balanceSats: null, reason: 'locked' }
  }

    markInboundPaymentStatus(id, 'Receiving')
  noteInboundReceivePending({
    txid: id,
    sats: typeof opts.satoshis === 'number' ? opts.satoshis : undefined,
  })
  setSyncHealth({
    phase: 'syncing',
    message: 'Importing BRC-29 payment',
  })

  try {
    let atomic = opts.tx
    if (!atomic || atomic.length === 0) {
      const beef = await getBeefForTxidCached(active, id, {
        allowUnprovenRawTx: true,
      })
      atomic = Array.from(beef.toBinaryAtomic(id))
    }

    if (atomic.length > 0) {
      await broadcastAtomicBeef(id, atomic)
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

    if (satoshis > 0 || hasActivityTxid(id, 'earned')) {
      noteInboundReceiveComplete({ txid: id, sats: satoshis })
    }

    scheduleHistoryBackupPush('internalizeAction')
    const balanceSats = await fetchBalanceSats(active.wallet).catch(() => null)

    markInboundPaymentStatus(id, 'Received')
    if (opts.announce !== false) {
      const amountLabel =
        satoshis > 0
          ? formatPrimaryFromSats(satoshis, getDisplayCurrency())
          : undefined
      toastSuccess('Payment received', amountLabel)
    }
    setSyncHealth({ phase: 'ok', message: null })
    return { accepted: true, satoshis, balanceSats }
  } catch (err) {
    if (alreadyInternalizedError(err)) {
      const satoshis =
        typeof opts.satoshis === 'number' && opts.satoshis > 0
          ? Math.floor(opts.satoshis)
          : 0
      if (satoshis > 0 || hasActivityTxid(id, 'earned')) {
        noteInboundReceiveComplete({ txid: id, sats: satoshis })
      }
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

/** Claim a `brc29:` settlement QR / paste (messagebox not required). */
export async function claimBrc29SettlementUri(
  raw: string,
): Promise<InternalizeBrc29Result> {
  const { tryParseBrc29SettlementUri } = await import('./brc29Uri')
  const parsed = tryParseBrc29SettlementUri(raw)
  if (!parsed) {
    return {
      accepted: false,
      satoshis: 0,
      balanceSats: null,
      reason: 'invalid-settlement-uri',
    }
  }
  return internalizeBrc29Payment({
    txid: parsed.txid,
    remittance: parsed.remittance,
    senderIdentityKey: parsed.senderIdentityKey,
    satoshis: parsed.sats ?? undefined,
  })
}

export type PaymentTipHint = {
  txid: string
  messageId?: string
  senderIdentityKey?: string
  satoshis?: number
  brc29?: Brc29Remittance
  /** Messagebox file URL for the signed Atomic BEEF (payee broadcasts). */
  beefUrl?: string
  tx?: number[]
  /** Soft-latch item settle — not a BSV payment. */
  item?: boolean
  /** Collectable name from the tip card memo, when known. */
  itemName?: string
}

/** Inbound chat cards still waiting to be internalized (inbox may already be ACKed). */
export function pendingBrc29HintsFromChat(): PaymentTipHint[] {
  const hints: PaymentTipHint[] = []
  for (const thread of listThreads()) {
    for (const msg of listMessages(thread.peerId)) {
      if (msg.direction !== 'in') continue
      if (msg.kind !== 'tip' && msg.kind !== 'pay-sent') continue
      const txid = (msg.meta?.txid || '').trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(txid)) continue
      const isItem = msg.meta?.item === true
      if (hasSettledActivityTxid(txid, 'earned', { item: isItem })) continue
      hints.push({
        txid,
        senderIdentityKey: msg.meta?.identityKey,
        satoshis: msg.meta?.sats,
        brc29: msg.meta?.brc29,
        item: isItem || undefined,
        itemName: msg.meta?.memo?.trim() || undefined,
      })
    }
  }
  return hints
}

/**
 * Chase tip/pay hints: BRC-29 remittance first, legacy address-P2PKH SPV second.
 */
export async function ingestPaymentsFromTipHints(
  hints: Array<string | PaymentTipHint>,
): Promise<{ imported: number; importedTxids: string[]; balanceSats: number | null }> {
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
      messageId: h.messageId,
      senderIdentityKey: h.senderIdentityKey,
      satoshis: h.satoshis,
      brc29: h.brc29,
      beefUrl: h.beefUrl,
      tx: h.tx,
      item: h.item === true || undefined,
      itemName: h.itemName?.trim() || undefined,
    })
  }

  const unique = new Map<string, PaymentTipHint>()
  for (const h of normalized) {
    const prev = unique.get(h.txid)
    if (
      !prev ||
      (h.brc29 && !prev.brc29) ||
      (h.item && !prev.item) ||
      (h.itemName && !prev.itemName) ||
      (h.beefUrl && !prev.beefUrl) ||
      (h.tx && !prev.tx)
    ) {
      unique.set(h.txid, { ...prev, ...h })
    }
  }

  for (const hint of unique.values()) {
    noteInboundReceivePending({
      txid: hint.txid,
      sats: hint.satoshis,
      item: hint.item,
      itemName: hint.itemName,
    })
  }

  let imported = 0
  const importedTxids: string[] = []
  let balanceSats: number | null = null
  // Soft-latch AtomicBEEF is expensive; do not hammer indexer 15×2s per tip poll.
  const ingestAttempts = 2
  const ingestDelayMs = 4_000

  for (const hint of unique.values()) {
    if (hint.item) {
      const { isAtomicBeefInBackoff } = await import('./beefCache')
      if (isAtomicBeefInBackoff(hint.txid)) continue
      const { internalizePeerItemSettle } = await import('./ingestItemSettle')
      let atomic = hint.tx
      if ((!atomic || !atomic.length) && hint.beefUrl) {
        atomic = await fetchAtomicBeefFromUrl(hint.beefUrl)
      }
      for (let attempt = 0; attempt < ingestAttempts; attempt++) {
        if (attempt > 0 && isAtomicBeefInBackoff(hint.txid)) break
        const result = await internalizePeerItemSettle({
          txid: hint.txid,
          tx: attempt === 0 ? atomic : undefined,
          beefUrl: attempt === 0 ? undefined : hint.beefUrl,
          name: hint.itemName,
        })
        if (result.accepted) {
          imported += 1
          importedTxids.push(hint.txid)
          break
        }
        if (attempt < ingestAttempts - 1) {
          await new Promise((r) => setTimeout(r, ingestDelayMs))
        }
      }
      continue
    }

    if (
      hint.brc29?.derivationPrefix &&
      hint.brc29?.derivationSuffix &&
      hint.senderIdentityKey
    ) {
      let atomic = hint.tx
      if ((!atomic || !atomic.length) && hint.beefUrl) {
        atomic = await fetchAtomicBeefFromUrl(hint.beefUrl)
      }
      for (let attempt = 0; attempt < ingestAttempts; attempt++) {
        const result = await internalizeBrc29Payment({
          txid: hint.txid,
          remittance: {
            derivationPrefix: hint.brc29.derivationPrefix,
            derivationSuffix: hint.brc29.derivationSuffix,
            outputIndex: hint.brc29.outputIndex ?? 0,
          },
          senderIdentityKey: hint.senderIdentityKey,
          tx: attempt === 0 ? atomic : undefined,
          satoshis: hint.satoshis,
        })
        if (result.balanceSats != null) balanceSats = result.balanceSats
        if (result.accepted) {
          imported += 1
          importedTxids.push(hint.txid)
          break
        }
        if (attempt < ingestAttempts - 1) {
          await new Promise((r) => setTimeout(r, ingestDelayMs))
        }
      }
      continue
    }

    // Legacy: tip without remittance — identity-address SPV sweep.
    const { ingestPaymentByTxid } = await import('./ingestPaymentByTxid')
    for (let attempt = 0; attempt < ingestAttempts; attempt++) {
      const result = await ingestPaymentByTxid(hint.txid)
      if (result.balanceSats != null) balanceSats = result.balanceSats
      if (result.imported > 0 || result.reason === 'already-imported') {
        imported += Math.max(
          result.imported,
          result.reason === 'already-imported' ? 1 : 0,
        )
        importedTxids.push(hint.txid)
        break
      }
      if (attempt < ingestAttempts - 1) {
        await new Promise((r) => setTimeout(r, ingestDelayMs))
      }
    }
  }

  return { imported, importedTxids, balanceSats }
}
