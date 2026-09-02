/**
 * Live payment / transfer progress for the status pill and send screens.
 *
 * Collectable / BRC-29 peer sends sign with `noSend` then settle (deliver or
 * fallback broadcast). External P2PKH still uses delayed `signAndProcess`.
 * Local balance check, building (collectables), and finishing are real edges
 * around that call — chain ingest is not required before pay.
 */

import {
  findPendingOutpointFlight,
  pendingOutpointFlightVerb,
} from './appActivity'

export type PaymentPhase =
  | 'idle'
  | 'preparing'
  | 'building'
  | 'signing'
  | 'broadcasting'
  | 'finishing'

export type PaymentProgress = {
  phase: PaymentPhase
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
  label: null,
  detail: null,
  outpoint: null,
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
  return outpoint.trim().replace(/\./g, '_')
}

function emit(): void {
  for (const listener of listeners) listener(progress)
}

let stuckWatchdog: ReturnType<typeof setTimeout> | null = null
const STUCK_PAYMENT_MS = 90_000

function clearStuckWatchdog(): void {
  if (stuckWatchdog) {
    clearTimeout(stuckWatchdog)
    stuckWatchdog = null
  }
}

function armStuckWatchdog(): void {
  clearStuckWatchdog()
  if (progress.phase === 'idle') return
  stuckWatchdog = setTimeout(() => {
    stuckWatchdog = null
    if (progress.phase === 'idle') return
    console.warn(
      '[payment-progress] stuck watchdog fired — clearing',
      progress.phase,
      progress.detail,
    )
    const detail = progress.detail?.trim()
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
    clearPaymentProgress()
    // Activity "Sending…" is durable and was not cleared by the pill alone.
    void import('./appActivity')
      .then(({ expireStaleOutboundPending }) => {
        const n = expireStaleOutboundPending(STUCK_PAYMENT_MS)
        if (n > 0) {
          console.warn(`[payment-progress] expired ${n} stuck Sending… Activity row(s)`)
        }
      })
      .catch(() => {})
  }, STUCK_PAYMENT_MS)
}

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
): void {
  if (phase === 'idle') {
    progress = { phase: 'idle', label: null, detail: null, outpoint: null }
    clearStuckWatchdog()
    emit()
    return
  }
  const copy = COPY[phase]
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
    label: nextLabel,
    detail: detail?.trim() || copy.detail,
    outpoint: nextOutpoint,
  }
  armStuckWatchdog()
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
