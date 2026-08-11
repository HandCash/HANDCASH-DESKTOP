/**
 * Live payment / transfer progress for the status pill and send screens.
 *
 * `createAction({ signAndProcess: true })` signs and broadcasts in one call, so
 * those two steps share a phase rather than inventing a fake boundary. Local
 * balance check, building (collectables), and finishing are real edges around
 * that call — chain ingest is not required before pay.
 */

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

export function getPaymentProgress(): PaymentProgress {
  return progress
}

export function getSendingOutpoint(): string | null {
  return progress.phase === 'idle' ? null : progress.outpoint
}

export function isOutpointSending(outpoint: string): boolean {
  if (progress.phase === 'idle' || !progress.outpoint) return false
  return progress.outpoint === normalizeOutpointKey(outpoint)
}

/**
 * Start (or update) payment UI. Pass `outpoint` on collectable sends so grid /
 * details can show a per-item Sending badge after the user leaves the panel.
 * Omitting `outpoint` keeps the previous in-flight outpoint (if any).
 */
export function setPaymentProgress(
  phase: PaymentPhase,
  detail?: string | null,
  outpoint?: string | null,
): void {
  if (phase === 'idle') {
    progress = { phase: 'idle', label: null, detail: null, outpoint: null }
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
  progress = {
    phase,
    label: copy.label,
    detail: detail?.trim() || copy.detail,
    outpoint: nextOutpoint,
  }
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
