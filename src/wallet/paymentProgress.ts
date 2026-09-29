/**
 * Live payment / transfer progress for the status pill and send screens.
 *
 * Collectable / BRC-29 peer sends sign with `noSend` then settle (deliver or
 * fallback broadcast). External P2PKH still uses delayed `signAndProcess`.
 * Local balance check, building (collectables), and finishing are real edges
 * around that call — chain ingest is not required before pay.
 */

import {
  beginWalletAction,
  endWalletAction,
  liveAction,
  onActionStuck,
  subscribeLiveActions,
  walletAction,
} from './actionLifecycle'
import type { ActionStage } from '../machines/actionLifecycleMachine'
import {
  findPendingOutpointFlight,
  pendingOutpointFlightVerb,
  WALLET_ACTIVITY_ORIGIN,
} from './appActivity'
import { toUnderscoreOutpoint } from './outpointFormat'
import {
  recordPaymentProgressStage,
  recordTransactionStage,
  type TransactionFlow,
} from './transactionTelemetry'

export type PaymentPhase =
  | 'idle'
  | 'preparing'
  | 'building'
  | 'signing'
  | 'broadcasting'
  | 'finishing'

export type PaymentProgress = {
  phase: PaymentPhase
  /** Identity boundary for the current operation, preserved across its phases. */
  startedAt: number | null
  /** Short pill / title line. */
  label: string | null
  /** Longer subtitle. */
  detail: string | null
  /**
   * Collectable outpoint in flight (normalized `txid_vout`). Used for inventory
   * / details badges while the user navigates away from the send screen.
   */
  outpoint: string | null
}

type Listener = (progress: PaymentProgress) => void

const listeners = new Set<Listener>()

let progress: PaymentProgress = {
  phase: 'idle',
  startedAt: null,
  label: null,
  detail: null,
  outpoint: null,
}
let telemetryFlow: TransactionFlow = 'payment'

function inferTelemetryFlow(
  label: string | null | undefined,
  outpoint: string | null | undefined,
): TransactionFlow {
  const value = (label || '').replace(/…/g, '').trim().toLowerCase()
  if (value.startsWith('listing')) return 'market_listing'
  if (value.startsWith('cancelling')) return 'market_cancel'
  if (value.startsWith('buying')) return 'market_purchase'
  if (value.startsWith('burning')) return 'burn'
  if (outpoint) return 'item_transfer'
  return 'payment'
}

const COPY: Record<
  Exclude<PaymentPhase, 'idle'>,
  { label: string; detail: string }
> = {
  preparing: {
    label: 'Sending…',
    detail: 'Preparing payment',
  },
  building: {
    label: 'Sending…',
    detail: 'Assembling the transaction',
  },
  signing: {
    label: 'Sending…',
    detail: 'Signing the transaction',
  },
  broadcasting: {
    label: 'Sending…',
    detail: 'Signing and sending to the network',
  },
  finishing: {
    label: 'Sending…',
    detail: 'Updating your balance',
  },
}

function normalizeOutpointKey(outpoint: string): string {
  return toUnderscoreOutpoint(outpoint)
}

/** Pill phases are the wallet's spend walking the shared action lifecycle. */
const STAGE_FOR_PHASE: Record<Exclude<PaymentPhase, 'idle'>, ActionStage> = {
  preparing: 'preparing',
  building: 'preparing',
  signing: 'signing',
  broadcasting: 'broadcasting',
  finishing: 'settling',
}

/**
 * An action that already has a lifecycle (the bridge's `action:<id>`) can borrow
 * the pill: its phases advance that action instead of starting a wallet one,
 * and clearing the pill leaves the action to settle or fail on its own terms.
 */
let boundActionId: string | null = null

export function bindPaymentProgressToAction(id: string | null): void {
  boundActionId = id
}

function walkLifecycle(previousPhase: PaymentPhase): void {
  if (boundActionId) {
    const bound = liveAction(boundActionId)
    if (progress.phase === 'idle') {
      boundActionId = null
      return
    }
    if (bound) {
      bound.stage(STAGE_FOR_PHASE[progress.phase])
      if (progress.outpoint) bound.touch([progress.outpoint])
    }
    return
  }
  if (progress.phase === 'idle') {
    endWalletAction('settled')
    return
  }
  const stage = STAGE_FOR_PHASE[progress.phase]
  const outpoints = progress.outpoint ? [progress.outpoint] : []
  if (previousPhase === 'idle' || !walletAction()) {
    beginWalletAction({
      origin: WALLET_ACTIVITY_ORIGIN,
      method: telemetryFlow,
      description: progress.label?.replace(/…/g, '').trim() || null,
      outpoints,
      startedAt: progress.startedAt ?? undefined,
      stage,
    })
    return
  }
  const live = walletAction()
  if (!live) return
  live.stage(stage)
  if (outpoints.length) live.touch(outpoints)
}

function emit(): void {
  for (const listener of listeners) listener(progress)
}

/** Hide the pill without settling the action — the send or the chart owns that. */
function dropPill(): void {
  if (progress.phase === 'idle') return
  progress = {
    phase: 'idle',
    startedAt: null,
    label: null,
    detail: null,
    outpoint: null,
  }
  emit()
}

const STUCK_PAYMENT_MS = 90_000

function spendView() {
  const bound = boundActionId ? liveAction(boundActionId)?.view() : null
  return bound ?? walletAction()?.view() ?? null
}

/**
 * Signed is a fact. The moment the action this pill is painting has a txid,
 * the pill goes idle — it does not keep saying Broadcasting through sealing
 * and payee notify. A later failure repaints through the Activity record.
 */
subscribeLiveActions(() => {
  if (progress.phase === 'idle') return
  const view = spendView()
  // Null during the id handoff (wallet: → the row's pendingId): the entry has
  // moved and `walletActionId` has not caught up. The publish that follows
  // carries it. Dropping the pill here made the next phase look like a new spend.
  if (!view) return
  if (view.txid || view.face === 'settled' || view.face === 'failed') dropPill()
})

onActionStuck((view) => {
  const detail = progress.detail?.trim()
  const stuckPhase = progress.phase
  dropPill()
  if (view.txid) return
  console.warn('[payment-progress] stuck before signing — aborting', view.id, view.face)
  void import('./spendGuard')
    .then(({ abortLiveExclusiveSpend }) => {
      const aborted = abortLiveExclusiveSpend('Send timed out')
      if (aborted) {
        console.warn('[payment-progress] aborted in-flight spend')
      } else {
        void import('./toast')
          .then(({ toastError }) => {
            toastError(
              'Send timed out',
              detail
                ? `${detail} — nothing was broadcast. Wait a moment, then try again.`
                : 'Signing took too long — nothing was broadcast. Wait a moment, then try again.',
            )
          })
          .catch(() => {})
        void import('./appActivity')
          .then(({ expireStaleOutboundPending }) => {
            const n = expireStaleOutboundPending(STUCK_PAYMENT_MS)
            if (n > 0) {
              console.warn(
                `[payment-progress] expired ${n} stuck Sending… Activity row(s)`,
              )
            }
          })
          .catch(() => {})
        void import('./chainedChangeHeal')
          .then(({ scheduleHealAfterSendCleanup }) => scheduleHealAfterSendCleanup())
          .catch(() => {})
      }
      if (stuckPhase !== 'idle') {
        recordTransactionStage('retry_exhausted', {
          flow: telemetryFlow,
          blockerCode: `stuck_${stuckPhase}`,
        })
      }
    })
    .catch(() => {})
})

export function getPaymentProgress(): PaymentProgress {
  return progress
}

export function getSendingOutpoint(): string | null {
  return progress.phase === 'idle' ? null : progress.outpoint
}

export function isOutpointSending(outpoint: string): boolean {
  const key = normalizeOutpointKey(outpoint)
  if (progress.phase !== 'idle' && progress.outpoint === key) return true
  return findPendingOutpointFlight(outpoint) != null
}

/** Verb for an in-flight outpoint: Listing, Cancelling, Buying, Burning, or Sending. */
export function inFlightVerb(outpoint: string): string | null {
  if (!isOutpointSending(outpoint)) return null
  const key = normalizeOutpointKey(outpoint)
  if (progress.phase !== 'idle' && progress.outpoint === key && progress.label) {
    const label = progress.label.replace(/…/g, '').trim()
    if (/^burn/i.test(label)) return 'Burning'
    if (/^list/i.test(label)) return 'Listing'
    if (/^cancel/i.test(label)) return 'Cancelling'
    if (/^buy/i.test(label)) return 'Buying'
    return 'Sending'
  }
  return pendingOutpointFlightVerb(outpoint) ?? 'Sending'
}

export function isMarketBusy(): boolean {
  const label = (progress.label || '').replace(/…/g, '').trim()
  return progress.phase !== 'idle' && /^(Listing|Cancelling|Buying)$/i.test(label)
}

const MARKET_BUSY: Record<string, { label: string; detail: string }> = {
  createMarketListingAdvert: {
    label: 'Listing…',
    detail: 'Creating the on-chain offer',
  },
  createCancelMarketListingAdvert: {
    label: 'Cancelling…',
    detail: 'Spending the offer token',
  },
  purchaseMarketListing: {
    label: 'Buying…',
    detail: 'Settling the purchase',
  },
}

/** Copy for a market method that keeps the wallet busy after approval. */
export function marketBusyCopy(method: string): { label: string; detail: string } | null {
  return MARKET_BUSY[method] ?? null
}

/**
 * Start (or update) payment UI. Pass `outpoint` on collectable sends so grid /
 * details can show a per-item Sending badge after the user leaves the panel.
 * Omitting `outpoint` keeps the previous in-flight outpoint (if any).
 *
 * `label` overrides the default “Sending…” — a listing is not a send. Later
 * phase updates keep that label unless a new one is passed, so the pill does
 * not flip back to Sending mid-offer.
 */
export function setPaymentProgress(
  phase: PaymentPhase,
  detail?: string | null,
  outpoint?: string | null,
  label?: string | null,
  flow?: TransactionFlow,
): void {
  if (phase === 'idle') {
    const previousPhase = progress.phase
    progress = {
      phase: 'idle',
      startedAt: null,
      label: null,
      detail: null,
      outpoint: null,
    }
    walkLifecycle(previousPhase)
    emit()
    return
  }
  // The chart already has the signature. Later phases (sealing, notifying)
  // must not bring the pill back.
  if (spendView()?.txid) return
  const copy = COPY[phase]
  const previousPhase = progress.phase
  const nextOutpoint =
    outpoint === undefined
      ? progress.outpoint
      : outpoint
        ? normalizeOutpointKey(outpoint)
        : null
  const nextLabel =
    label !== undefined
      ? label?.trim() || copy.label
      : progress.phase !== 'idle' && progress.label
        ? progress.label
        : copy.label
  progress = {
    phase,
    startedAt:
      previousPhase === 'idle' ? Date.now() : progress.startedAt ?? Date.now(),
    label: nextLabel,
    detail: detail?.trim() || copy.detail,
    outpoint: nextOutpoint,
  }
  telemetryFlow =
    flow ??
    (previousPhase === 'idle'
      ? inferTelemetryFlow(nextLabel, nextOutpoint)
      : telemetryFlow)
  if (phase !== previousPhase) {
    recordPaymentProgressStage(telemetryFlow, phase)
  }
  walkLifecycle(previousPhase)
  emit()
}

export function clearPaymentProgress(): void {
  setPaymentProgress('idle')
}

export function subscribePaymentProgress(listener: Listener): () => void {
  listeners.add(listener)
  listener(progress)
  return () => {
    listeners.delete(listener)
  }
}
