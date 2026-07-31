/** Prefill for SendPanel when launched from chat `/pay`. */

export type SendPrefill = {
  to?: string
  friendLabel?: string
  /** Display amount string for the amount field (e.g. "2.18" for USD) */
  amount?: string
  /** When 'sats', amount is satoshis as decimal-ish string for amount field */
  amountUnit?: 'usd' | 'bsv' | 'sats'
  memo?: string
}

let pending: SendPrefill | null = null

export function setSendPrefill(prefill: SendPrefill | null): void {
  pending = prefill
}

export function takeSendPrefill(): SendPrefill | null {
  const next = pending
  pending = null
  return next
}

export function peekSendPrefill(): SendPrefill | null {
  return pending
}
