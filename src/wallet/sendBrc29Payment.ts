/**
 * BRC-29 peer payments (HandCash ↔ HandCash).
 *
 * Sender signs (`createAction` noSend) and delivers Atomic BEEF + remittance
 * to the payee. The **payee** internalizes and broadcasts. Sender only
 * broadcasts if peer delivery fails (so noSend funds are not stuck).
 *
 * Plain identity-address P2PKH stays in sendPayment.ts for external addresses.
 */
import { Beef, createNonce, P2PKH, PublicKey } from '@bsv/sdk'
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
 * Sign a BRC-29 payment and deliver it to the payee (they broadcast).
 * If messagebox delivery fails, sender broadcasts so noSend inputs are not stuck.
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

          setPaymentProgress('broadcasting', 'Signing payment for the recipient')
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
              noSend: true,
              trustSelf: 'known',
            },
          })

          const realTxid = (result as { txid?: string })?.txid
          const atomicBeef = atomicBeefFromCreateAction(result)
          if (!realTxid || !atomicBeef?.length) {
            throw new Error('Wallet did not return a signed payment to deliver')
          }
          const txid = realTxid
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

          let selfReceived = false
          let peerDelivered = false
          let balanceSats = Math.max(
            0,
            (await fetchBalanceSats(active.wallet).catch(() => 0)) || 0,
          )

          const payingSelf =
            Boolean(active.identityKey) &&
            normalizeIdentityKey(active.identityKey) === payee

          if (payingSelf) {
            setPaymentProgress('finishing', 'Crediting payment back to this wallet')
            await broadcastAtomicBeef(txid, atomicBeef)
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
          } else {
            setPaymentProgress('finishing', 'Delivering payment to recipient')
            try {
              const { listFriends } = await import('./friends')
              const { notifyPeerBrc29Payment } = await import('./messageTransport')
              const friend =
                listFriends().find(
                  (f) => f.identityKey.toLowerCase() === payee.toLowerCase(),
                ) ?? null
              const delivered = await notifyPeerBrc29Payment({
                recipientIdentityKey: payee,
                rootKeyHex: active.rootKeyHex,
                senderIdentityKey: active.identityKey,
                messagebox: friend?.messagebox,
                txid,
                satoshis,
                remittance,
                atomicBeef,
                amountLabel: opts.friendLabel ?? undefined,
              })
              peerDelivered =
                delivered.delivered === 'cloud' && delivered.beefUploaded === true
            } catch (err) {
              console.warn(
                '[brc29] peer delivery failed',
                err instanceof Error ? err.message : String(err),
              )
            }
            if (!peerDelivered) {
              setPaymentProgress('finishing', 'Submitting payment (recipient offline)')
              await broadcastAtomicBeef(txid, atomicBeef)
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
  /** Toast “Payment received” (default true). Quiet for same-device self-pay. */
  announce?: boolean
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
  setSyncHealth({
    phase: 'syncing',
    message: 'Importing BRC-29 payment',
  })

  try {
    let atomic = opts.tx
    if (!atomic || atomic.length === 0) {
      const beef = await getBeefForTxidCached(active, id)
      atomic = beef.toBinaryAtomic(id)
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
  senderIdentityKey?: string
  satoshis?: number
  brc29?: Brc29Remittance
  /** Messagebox file URL for the signed Atomic BEEF (payee broadcasts). */
  beefUrl?: string
  tx?: number[]
  /** Soft-latch item settle — not a BSV payment. */
  item?: boolean
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
      beefUrl: h.beefUrl,
      tx: h.tx,
      item: h.item === true || undefined,
    })
  }

  const unique = new Map<string, PaymentTipHint>()
  for (const h of normalized) {
    const prev = unique.get(h.txid)
    if (
      !prev ||
      (h.brc29 && !prev.brc29) ||
      (h.item && !prev.item) ||
      (h.beefUrl && !prev.beefUrl) ||
      (h.tx && !prev.tx)
    ) {
      unique.set(h.txid, { ...prev, ...h })
    }
  }

  let imported = 0
  let balanceSats: number | null = null

  for (const hint of unique.values()) {
    if (hint.item) {
      const { internalizePeerItemSettle } = await import('./ingestItemSettle')
      let atomic = hint.tx
      if ((!atomic || !atomic.length) && hint.beefUrl) {
        atomic = await fetchAtomicBeefFromUrl(hint.beefUrl)
      }
      for (let attempt = 0; attempt < 6; attempt++) {
        const result = await internalizePeerItemSettle({
          txid: hint.txid,
          tx: attempt === 0 ? atomic : undefined,
          beefUrl: attempt === 0 ? undefined : hint.beefUrl,
        })
        if (result.accepted) {
          imported += 1
          break
        }
        if (attempt < 5) await new Promise((r) => setTimeout(r, 1_000))
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
      for (let attempt = 0; attempt < 6; attempt++) {
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
