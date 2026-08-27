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
  failOutboundSendPending,
  clearInboundReceivePending,
} from './appActivity'
import { getBeefForTxidCached } from './beefCache'
import { withVisibleOnChainBeef } from './legacyBeef'
import { isGhostTxSuppressed, rememberGhostTx } from './ghostTxSuppress'
import {
  beginPendingSend,
  clearPendingSend,
  completePendingSend,
} from './pendingSend'
import { fetchBalanceSats, getActiveWallet } from './session'
import { publishDisplayBalanceRefresh } from './displayBalanceRefresh'
import {
  describeInsufficientFunds,
  isInsufficientFundsError,
} from './insufficientFunds'
import { assertOnlineForPayment } from './paymentPolicy'
import {
  prepareSpendHeal,
  runExclusiveSpend,
} from './spendGuard'
import { scheduleHistoryBackupPush } from './deviceSync'
import {
  isAlreadySpentInputError,
  onAlreadySpentSend,
  releaseSealedInputsOfUnsentTx,
  sealSpentInputsOfSignedTx,
} from './staleOutputRelease'
import {
  clearPaymentProgress,
  setPaymentProgress,
} from './paymentProgress'
import { validateIdentityKey, normalizeIdentityKey } from './friends'
import { chooseBrc29SettlePath } from './brc29SettlePath'
import { releaseStuckNosends, sendWithHasFailure } from './actionReview'
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
import type { ItemTransferAsset } from './messageStore'
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
  opts?: { skipIfOnChain?: boolean },
): Promise<boolean> {
  const id = txid.trim().toLowerCase()
  const active = getActiveWallet()
  if (!active || !/^[0-9a-f]{64}$/.test(id) || !atomic.length) return false
  const t0 = Date.now()
  const mark = (phase: string) => {
    console.info(`[brc29-ingest ${id.slice(0, 12)}…] +${Date.now() - t0}ms ${phase}`)
  }
  try {
    // BRC-29 sender already broadcast — optional existence check saves a full
    // multi-provider postBeef RTT. Item peerDeliver must not use this (payee
    // is often the first broadcaster; the check would only add latency).
    if (opts?.skipIfOnChain) {
      const { txExistsOnChain } = await import('./legacyScan')
      const onChain = await txExistsOnChain(id, active.chain)
      mark(`exists=${String(onChain)}`)
      if (onChain === true) return true
    }

    const { summarizePostBeef } = await import('./postBeefResult')
    const results = await active.services.postBeef(Beef.fromBinary(atomic), [id])
    const accepted = summarizePostBeef(results as never).accepted
    mark(`postBeef accepted=${String(accepted)}`)
    return accepted
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
export async function ensurePaymentBroadcasted(
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
    // Nothing was broadcast, so the pre-broadcast seal is holding live coins.
    await releaseSealedInputsOfUnsentTx(id, atomic)
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
    await onAlreadySpentSend({ txid: id, atomic })
  } else {
    // Nobody reported these inputs gone, so nothing was spent — the failure was
    // transport. Hand the coins back rather than letting a no-network attempt
    // shrink the spendable balance.
    await releaseSealedInputsOfUnsentTx(id, atomic)
  }
  throw new Error(formatPostBeefFailure(summary))
}

export function atomicBeefFromCreateAction(result: unknown): number[] | undefined {
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
        const sendStarted = Date.now()
        const mark = (phase: string) => {
          console.info(`[brc29] +${Date.now() - sendStarted}ms ${phase}`)
        }
        // BRC-29 key derivation reads only the root key + counterparty — never
        // the UTXO set or action-batch reservations — so start it now and let it
        // overlap the nosend + balance prep instead of paying both serially.
        // Guarded so an early rejection cannot escape as an unhandled rejection
        // before it is awaited below.
        let keyMaterialErr: unknown = null
        const keyMaterialP = (async () => {
          const [derivationPrefix, derivationSuffix] = await Promise.all([
            createNonce(active.wallet, 'self'),
            createNonce(active.wallet, 'self'),
          ])
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
          return { derivationPrefix, derivationSuffix, lockingScript }
        })().catch((err) => {
          keyMaterialErr = err
          return null
        })

        await releaseStuckNosends(active)
        mark('nosends released')
        // Sequential on purpose: aborting stuck batches frees reserved outputs,
        // so a balance read beside it could under-report and refuse a valid send.
        // Confirmed toolbox balance is checked first; the unconfirmed-change
        // graveyard scan only runs when that is short.
        await prepareSpendHeal(satoshis)
        mark('ready')
        chart.send({ type: 'READY' })

        noteOutboundSendPending({
          pendingId: pending.id,
          sats: satoshis,
          to: payee,
          friendLabel: opts.friendLabel ?? null,
        })

        let signedTxid: string | undefined
        let signedAtomic: number[] | undefined
        try {
          const keyMaterial = await keyMaterialP
          if (!keyMaterial) {
            throw keyMaterialErr ?? new Error('Failed to derive BRC-29 keys')
          }
          const { derivationPrefix, derivationSuffix, lockingScript } = keyMaterial
          mark('keys ready')
          const remittance: Brc29Remittance = {
            derivationPrefix,
            derivationSuffix,
            outputIndex: 0,
          }

          setPaymentProgress('broadcasting', 'Signing and broadcasting your payment')
          const createActionArgs = {
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
              trustSelf: 'known' as const,
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
              '[brc29] createAction poison — repairing and retrying once',
              firstErr instanceof Error ? firstErr.message : String(firstErr),
            )
            await recoverFromReviewActions({ err: firstErr, active })
            result = await active.wallet.createAction(createActionArgs)
          }

          const realTxid = (result as { txid?: string })?.txid
          const atomicBeef = atomicBeefFromCreateAction(result)
          signedTxid = realTxid
          signedAtomic = atomicBeef
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
          mark(`createAction ${txid.slice(0, 12)}…`)
          // Retire the coins this transaction just consumed before the next send
          // can pick them. Chain-ingest's rehide pass yields while a spend is
          // queued, so a burst of sends would otherwise reselect a spent input
          // and get rejected as a double spend.
          await sealSpentInputsOfSignedTx(txid, atomicBeef)
          mark('inputs sealed')
          setPaymentProgress('broadcasting', 'Confirming payment on the network')
          await ensurePaymentBroadcasted(txid, atomicBeef)
          mark('broadcast')
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
            // spent. Never releaseSpendable here (that wrote off ~$0.10 of live
            // coins on failed Mobile→Desktop retries).
            if (isAlreadySpentInputError(err)) {
              await onAlreadySpentSend({ txid: signedTxid, atomic: signedAtomic })
            }
            const message = formatReviewActionsError(err)
            console.warn('[brc29] send failed', message, err)
            chart.send({ type: 'FAIL', error: message })
            throw new Error(message)
          }
          if (isInsufficientFundsError(err)) {
            const message = await describeInsufficientFunds(
              active.wallet,
              satoshis,
            )
            console.warn('[brc29] insufficient funds', message, err)
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
    failOutboundSendPending({
      pendingId: pending.id,
      reason: err instanceof Error ? err.message : String(err),
    })
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

  const ingestStarted = Date.now()
  const markIngest = (phase: string) => {
    console.info(
      `[brc29-ingest ${id.slice(0, 12)}…] +${Date.now() - ingestStarted}ms ${phase}`,
    )
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

  const balanceBefore = await fetchBalanceSats(active.wallet).catch(() => null)

  try {
    let atomic = opts.tx
    if (!atomic || atomic.length === 0) {
      const beef = await getBeefForTxidCached(active, id, {
        allowUnprovenRawTx: true,
      })
      atomic = Array.from(beef.toBinaryAtomic(id))
      markIngest(`beef bytes=${atomic.length}`)
    } else {
      markIngest(`beef inline bytes=${atomic.length}`)
    }

    if (atomic.length > 0) {
      // BRC-29 sender already broadcast — overlap confirm with internalize.
      let existsMs = 0
      let internalizeMs = 0
      const broadcastP = (async () => {
        const t0 = Date.now()
        const ok = await broadcastAtomicBeef(id, atomic!, { skipIfOnChain: true })
        existsMs = Date.now() - t0
        return ok
      })()
      const internalizeP = (async () => {
        const t0 = Date.now()
        await withVisibleOnChainBeef(() =>
          active.wallet.internalizeAction({
            tx: atomic!,
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
          }),
        )
        internalizeMs = Date.now() - t0
      })()
      await Promise.all([broadcastP, internalizeP])
      markIngest(
        `parallel exists/postBeef=${existsMs}ms internalize=${internalizeMs}ms`,
      )
    } else {
      const t0 = Date.now()
      await withVisibleOnChainBeef(() =>
        active.wallet.internalizeAction({
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
        }),
      )
      markIngest(`internalize-only ${Date.now() - t0}ms`)
    }

    const satoshis =
      typeof opts.satoshis === 'number' && opts.satoshis > 0
        ? Math.floor(opts.satoshis)
        : 0

    if (satoshis > 0 || hasActivityTxid(id, 'earned')) {
      noteInboundReceiveComplete({ txid: id, sats: satoshis })
    }

    scheduleHistoryBackupPush('internalizeAction')
    const balanceStarted = Date.now()
    const balanceSats = await fetchBalanceSats(active.wallet).catch(() => null)
    markIngest(`balance ${Date.now() - balanceStarted}ms`)
    if (balanceSats != null) publishDisplayBalanceRefresh(balanceSats)

    markInboundPaymentStatus(id, 'Received')
    const gained =
      balanceBefore != null && balanceSats != null
        ? balanceSats - balanceBefore
        : satoshis
    if (opts.announce !== false && gained > 0) {
      toastSuccess(
        'Payment received',
        formatPrimaryFromSats(gained, getDisplayCurrency()),
      )
    } else if (opts.announce !== false && gained <= 0) {
      console.info(
        `[brc29] internalized ${id.slice(0, 12)}… without a balance rise — no receive toast`,
      )
    }
    setSyncHealth({ phase: 'ok', message: null })
    markIngest('done')
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
      if (balanceSats != null) publishDisplayBalanceRefresh(balanceSats)
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
  /** Item/token settle — not a BSV payment. */
  item?: boolean
  /** Collectable name from the tip card memo, when known. */
  itemName?: string
  /** Tagged asset grammar; absent means legacy collectable. */
  asset?: ItemTransferAsset
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
        asset: msg.meta?.asset,
      })
    }
  }
  return hints
}

/**
 * Chase tip/pay hints: BRC-29 remittance first, legacy address-P2PKH SPV second.
 * Ghost txids (confirmed 404 with no BEEF left) are returned so the inbox can ACK.
 *
 * Independent tips run with bounded concurrency — wall-clock ≈ batches, not N×RTT.
 */
export async function ingestPaymentsFromTipHints(
  hints: Array<string | PaymentTipHint>,
): Promise<{
  imported: number
  importedTxids: string[]
  ghostTxids: string[]
  balanceSats: number | null
}> {
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
      asset: h.asset,
    })
  }

  const unique = new Map<string, PaymentTipHint>()
  for (const h of normalized) {
    if (isGhostTxSuppressed(h.txid)) continue
    const prev = unique.get(h.txid)
    if (
      !prev ||
      (h.brc29 && !prev.brc29) ||
      (h.item && !prev.item) ||
      (h.asset && !prev.asset) ||
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
      token: hint.asset?.kind === 'fungible' ? hint.asset : undefined,
    })
  }

  // Item/token AtomicBEEF is expensive; keep retries bounded per tip poll.
  const ingestAttempts = 2
  const ingestDelayMs = 4_000
  /** Concurrent tip internalizations — BEEF + postBeef are heavy. */
  const TIP_INGEST_CONCURRENCY = 3

  const ghostTxids: string[] = []
  const markGhostIfMissing = async (
    txid: string,
    hadLocalBeef: boolean,
  ): Promise<void> => {
    // peerDeliver soft-latch may be off-chain until payee broadcasts — only
    // ghost when there is nothing left to internalize.
    if (hadLocalBeef) return
    try {
      const { txExistsOnChain } = await import('./legacyScan')
      const { getActiveWallet } = await import('./session')
      const active = getActiveWallet()
      if (!active) return
      const onChain = await txExistsOnChain(txid, active.chain)
      if (onChain !== false) return
      rememberGhostTx(txid)
      clearInboundReceivePending(txid)
      if (!ghostTxids.includes(txid)) ghostTxids.push(txid)
      console.info(
        `[tip-ingest] ghost tip ${txid.slice(0, 12)}… — 404 on-chain, no BEEF`,
      )
    } catch {
      // inconclusive
    }
  }

  const { mapPool } = await import('./asyncPool')
  const hintList = [...unique.values()]

  const outcomes = await mapPool(hintList, TIP_INGEST_CONCURRENCY, async (hint) => {
    let importedTxid: string | null = null
    let balanceSats: number | null = null

    if (hint.item) {
      let atomic = hint.tx
      if ((!atomic || !atomic.length) && hint.beefUrl) {
        atomic = await fetchAtomicBeefFromUrl(hint.beefUrl)
      }
      const hadLocalBeef = !!(atomic && atomic.length > 0)
      let accepted = false
      for (let attempt = 0; attempt < ingestAttempts; attempt++) {
        const asset = hint.asset
        const result =
          asset?.kind === 'fungible'
            ? await import('./ingestFungibleSettle').then(
                ({ internalizePeerFungibleSettle }) =>
                  internalizePeerFungibleSettle({
                    txid: hint.txid,
                    tx: attempt === 0 ? atomic : undefined,
                    beefUrl: attempt === 0 ? undefined : hint.beefUrl,
                    token: asset,
                    beefPurpose: 'inboundItemHint',
                  }),
              )
            : asset?.kind === '1sat-ft'
              ? await import('./ingestColourSettle').then(
                  ({ internalizePeerColourSettle }) =>
                    internalizePeerColourSettle({
                      txid: hint.txid,
                      tx: attempt === 0 ? atomic : undefined,
                      beefUrl: attempt === 0 ? undefined : hint.beefUrl,
                      token: asset,
                      beefPurpose: 'inboundItemHint',
                    }),
                )
              : await import('./ingestItemSettle').then(
                  ({ internalizePeerItemSettle }) =>
                    internalizePeerItemSettle({
                      txid: hint.txid,
                      tx: attempt === 0 ? atomic : undefined,
                      beefUrl: attempt === 0 ? undefined : hint.beefUrl,
                      name: hint.itemName,
                      beefPurpose: 'inboundItemHint',
                    }),
                )
        if (result.accepted) {
          importedTxid = hint.txid
          accepted = true
          break
        }
        if (attempt < ingestAttempts - 1) {
          await new Promise((r) => setTimeout(r, ingestDelayMs))
        }
      }
      if (!accepted) await markGhostIfMissing(hint.txid, hadLocalBeef)
      return { importedTxid, balanceSats }
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
      const hadLocalBeef = !!(atomic && atomic.length > 0)
      let accepted = false
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
          importedTxid = hint.txid
          accepted = true
          break
        }
        if (attempt < ingestAttempts - 1) {
          await new Promise((r) => setTimeout(r, ingestDelayMs))
        }
      }
      if (!accepted) await markGhostIfMissing(hint.txid, hadLocalBeef)
      return { importedTxid, balanceSats }
    }

    // Legacy: tip without remittance — identity-address SPV sweep.
    const { ingestPaymentByTxid } = await import('./ingestPaymentByTxid')
    let accepted = false
    for (let attempt = 0; attempt < ingestAttempts; attempt++) {
      const result = await ingestPaymentByTxid(hint.txid)
      if (result.balanceSats != null) balanceSats = result.balanceSats
      if (result.imported > 0 || result.reason === 'already-imported') {
        importedTxid = hint.txid
        accepted = true
        break
      }
      if (attempt < ingestAttempts - 1) {
        await new Promise((r) => setTimeout(r, ingestDelayMs))
      }
    }
    if (!accepted) await markGhostIfMissing(hint.txid, false)
    return { importedTxid, balanceSats }
  })

  const importedTxids: string[] = []
  let balanceSats: number | null = null
  for (const o of outcomes) {
    if (o.importedTxid) importedTxids.push(o.importedTxid)
    if (o.balanceSats != null) balanceSats = o.balanceSats
  }

  return {
    imported: importedTxids.length,
    importedTxids,
    ghostTxids,
    balanceSats,
  }
}
