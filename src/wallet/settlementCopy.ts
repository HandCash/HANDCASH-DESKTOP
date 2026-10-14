/**
 * User-facing settlement language.
 *
 * Internal buckets stay (`pendingChange`, Activity `status: pending`). This
 * module is the only place those become words on screen. "Pending" as
 * "a service is processing this" is forbidden.
 *
 *   Signed       — local cheque (Atomic BEEF). Assumed the moment it is signed.
 *                  Miner acceptance is a background chase, not this phrase.
 *   Sent         — a provider accepted/announced the signed body
 *   Seen         — another network observer reported it
 *   Confirmed    — BUMP vs this device's headers; the UI returns to its timestamp
 */
import type { ArcStatus } from './txLifecycle'

export type SettlementPhrase = 'signed' | 'sent' | 'seen' | 'confirmed'

export type SettlementCopy = {
  phrase: SettlementPhrase
  confirmations: number | null
}

export function confirmationsFromHeights(
  minedHeight: number | null | undefined,
  tipHeight: number | null | undefined,
): number | null {
  if (
    minedHeight == null ||
    tipHeight == null ||
    !Number.isFinite(minedHeight) ||
    !Number.isFinite(tipHeight)
  ) {
    return null
  }
  const mined = Math.trunc(minedHeight)
  const tip = Math.trunc(tipHeight)
  if (mined <= 0 || tip < mined) return null
  return tip - mined + 1
}

export function classifyActivitySettlement(args: {
  status?: 'pending' | 'complete' | 'failed'
  hasTxid: boolean
  chainProof?: 'unconfirmed' | 'headerProven' | null
  arcStatus?: ArcStatus | null
}): SettlementPhrase {
  if (args.chainProof === 'headerProven') return 'confirmed'
  if (args.arcStatus === 'SEEN_ON_NETWORK') return 'seen'
  if (
    args.arcStatus === 'STORED' ||
    args.arcStatus === 'ANNOUNCED_TO_NETWORK' ||
    args.chainProof === 'unconfirmed'
  ) return 'sent'
  // A txid is the assumption. It does not mean a miner has accepted it.
  return 'signed'
}

export function formatSettlementLabel(copy: SettlementCopy): string {
  if (copy.phrase === 'signed') return 'Signed'
  if (copy.phrase === 'sent') return 'Sent'
  if (copy.phrase === 'seen') return 'Seen on network'
  const n = copy.confirmations
  if (n == null || n <= 0) return 'Confirmed'
  if (n === 1) return 'Confirmed · 1 block'
  return `Confirmed · ${n} blocks`
}

/**
 * In-flight Activity slot. `null` means the row should keep its timestamp
 * (not a settlement story).
 */
export function inFlightSettlementLabel(args: {
  status?: 'pending' | 'complete' | 'failed'
  txid?: string
  chainProof?: 'unconfirmed' | 'headerProven' | null
  arcStatus?: ArcStatus | null
  minedHeight?: number | null
  tipHeight?: number | null
}): string | null {
  if (args.status === 'failed') return null
  if (!args.txid?.trim()) return args.status === 'pending' ? 'Signed' : null
  // A verified mined row returns to its ordinary date/time: that timestamp is
  // the compact confirmation affordance the activity feed already understands.
  if (args.chainProof === 'headerProven') return null
  const phrase = classifyActivitySettlement({
    status: args.status,
    hasTxid: Boolean(args.txid?.trim()),
    chainProof: args.chainProof,
    arcStatus: args.arcStatus,
  })
  return formatSettlementLabel({
    phrase,
    confirmations: confirmationsFromHeights(args.minedHeight, args.tipHeight),
  })
}
