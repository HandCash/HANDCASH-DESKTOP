/**
 * User-facing settlement language.
 *
 * Internal buckets stay (`pendingChange`, Activity `status: pending`). This
 * module is the only place those become words on screen. "Pending" as
 * "a service is processing this" is forbidden.
 *
 *   Signed       — local cheque (Atomic BEEF), not header-final
 *   Unconfirmed  — network has / can have the body; reorg still possible
 *   Confirmed    — BUMP vs this device's headers; optional block depth
 */
export type SettlementPhrase = 'signed' | 'unconfirmed' | 'confirmed'

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
}): SettlementPhrase {
  if (args.chainProof === 'headerProven') return 'confirmed'
  if (args.chainProof === 'unconfirmed') return 'unconfirmed'
  if (args.hasTxid) return 'unconfirmed'
  if (args.status === 'pending') return 'signed'
  return 'signed'
}

export function formatSettlementLabel(copy: SettlementCopy): string {
  if (copy.phrase === 'signed') return 'Signed'
  if (copy.phrase === 'unconfirmed') return 'Unconfirmed'
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
  minedHeight?: number | null
  tipHeight?: number | null
}): string | null {
  if (args.status === 'failed') return null
  if (args.status !== 'pending' && args.chainProof !== 'headerProven') {
    return null
  }
  const phrase = classifyActivitySettlement({
    status: args.status,
    hasTxid: Boolean(args.txid?.trim()),
    chainProof: args.chainProof,
  })
  return formatSettlementLabel({
    phrase,
    confirmations: confirmationsFromHeights(args.minedHeight, args.tipHeight),
  })
}
