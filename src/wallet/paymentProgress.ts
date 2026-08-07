/**
 * Live payment / transfer progress for the status pill and send screens.
 *
 * `createAction({ signAndProcess: true })` signs and broadcasts in one call, so
 * those two steps share a phase rather than inventing a fake boundary. Healing,
 * building (collectables), and finishing are real edges around that call.
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
}

type Listener = (progress: PaymentProgress) => void

const listeners = new Set<Listener>()

let progress: PaymentProgress = {
  phase: 'idle',
  label: null,
  detail: null,
}

const COPY: Record<
  Exclude<PaymentPhase, 'idle'>,
  { label: string; detail: string }
> = {
  preparing: {
    label: 'Preparing…',
    detail: 'Checking spendable funds',
  },
  building: {
    label: 'Building…',
    detail: 'Assembling the transaction',
  },
  signing: {
    label: 'Signing…',
    detail: 'Signing the transaction',
  },
  broadcasting: {
    label: 'Broadcasting…',
    detail: 'Signing and sending to the network',
  },
  finishing: {
    label: 'Finishing…',
    detail: 'Updating your balance',
  },
}

function emit(): void {
  for (const listener of listeners) listener(progress)
}

export function getPaymentProgress(): PaymentProgress {
  return progress
}

export function setPaymentProgress(
  phase: PaymentPhase,
  detail?: string | null,
): void {
  if (phase === 'idle') {
    progress = { phase: 'idle', label: null, detail: null }
    emit()
    return
  }
  const copy = COPY[phase]
  progress = {
    phase,
    label: copy.label,
    detail: detail?.trim() || copy.detail,
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
