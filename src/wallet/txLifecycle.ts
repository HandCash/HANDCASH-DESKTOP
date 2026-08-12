/**
 * Dual-layer transaction lifecycle — optimistic UI vs cryptographic finality.
 *
 * Sit *beside* soft-latch / BRC-29 / BSV send machines (who broadcasts / peer
 * deliver). This module owns network confirmation: ARC status → mempool →
 * MINED only after a verified BUMP against local headers.
 *
 * Never treat HTTP 200 / postBeef accept as hard finality.
 */

/** Durable local tx states — map 1:1 onto ARC pipeline where applicable. */
export type TxStatus =
  | 'DRAFT'
  | 'VALIDATING'
  | 'BROADCASTING'
  | 'SEEN_IN_MEMPOOL'
  | 'MINED'
  | 'FAILED_REJECTED'
  | 'REORG_ORPHANED'

/**
 * ARC broadcast / callback statuses (BSV Association ARC).
 * Local `TxStatus` is derived from these — never invent finality from HTTP 200.
 */
export type ArcStatus =
  | 'STORED'
  | 'ANNOUNCED_TO_NETWORK'
  | 'SEEN_ON_NETWORK'
  | 'MINED'
  | 'REJECTED'
  | 'DOUBLE_SPEND_ATTEMPTED'

/** User-facing diagnostic codes — halt before UTXO mutation when validation fails. */
export type TxDiagnosticCode =
  | 'DUST_OUTPUT'
  | 'INVALID_SATOSHIS'
  | 'INSUFFICIENT_FUNDS'
  | 'EMPTY_INPUTS'
  | 'FEE_TOO_LOW'
  | 'SCRIPT_INVALID'
  | 'PROTOCOL_REFUSE'
  | 'ARC_REJECTED'
  | 'ARC_DOUBLE_SPEND'
  | 'BUMP_UNVERIFIED'
  | 'REORG'
  | 'UNKNOWN'

export type TxRecord = {
  /** Local draft / pending id (stable across broadcast). */
  id: string
  status: TxStatus
  /** Set once the wallet commits a txid. */
  txid: string | null
  satoshis: number
  to: string | null
  /** Soft-locked input outpoints (`txid_vout`). */
  inputOutpoints: string[]
  arcStatus: ArcStatus | null
  diagnostic: TxDiagnosticCode | null
  diagnosticDetail: string | null
  /** Block height when SPV-verified mined (null until MINED). */
  minedHeight: number | null
  createdAt: number
  updatedAt: number
}

const TX_FORWARD: Readonly<Record<TxStatus, ReadonlySet<TxStatus>>> = {
  DRAFT: new Set(['VALIDATING', 'FAILED_REJECTED']),
  VALIDATING: new Set(['BROADCASTING', 'FAILED_REJECTED']),
  BROADCASTING: new Set(['SEEN_IN_MEMPOOL', 'FAILED_REJECTED']),
  SEEN_IN_MEMPOOL: new Set(['MINED', 'FAILED_REJECTED', 'REORG_ORPHANED']),
  MINED: new Set(['REORG_ORPHANED']),
  FAILED_REJECTED: new Set([]),
  REORG_ORPHANED: new Set(['SEEN_IN_MEMPOOL', 'FAILED_REJECTED']),
}

/** Legal status transition? Fail-closed for unknown edges. */
export function canTransitionTx(from: TxStatus, to: TxStatus): boolean {
  if (from === to) return true
  return TX_FORWARD[from]?.has(to) ?? false
}

/**
 * Map ARC status → local TxStatus.
 * MINED here is *claimed* by ARC — callers must still verify BUMP before
 * committing `TxStatus.MINED`.
 */
export function txStatusFromArc(arc: ArcStatus): TxStatus {
  switch (arc) {
    case 'STORED':
    case 'ANNOUNCED_TO_NETWORK':
      return 'BROADCASTING'
    case 'SEEN_ON_NETWORK':
      return 'SEEN_IN_MEMPOOL'
    case 'MINED':
      // Claimed mined — not hard finality until BUMP verifies.
      return 'SEEN_IN_MEMPOOL'
    case 'REJECTED':
    case 'DOUBLE_SPEND_ATTEMPTED':
      return 'FAILED_REJECTED'
  }
}

export function diagnosticFromArc(arc: ArcStatus): TxDiagnosticCode | null {
  if (arc === 'REJECTED') return 'ARC_REJECTED'
  if (arc === 'DOUBLE_SPEND_ATTEMPTED') return 'ARC_DOUBLE_SPEND'
  return null
}

/** Normalize outpoint keys to `txid_vout`. */
export function normalizeOutpointKey(outpoint: string): string {
  return outpoint.trim().replace(/\./g, '_').toLowerCase()
}

export function isHardFinal(status: TxStatus): boolean {
  return status === 'MINED'
}

export function isTerminalFailure(status: TxStatus): boolean {
  return status === 'FAILED_REJECTED'
}

export function isOptimisticPending(status: TxStatus): boolean {
  return (
    status === 'DRAFT' ||
    status === 'VALIDATING' ||
    status === 'BROADCASTING' ||
    status === 'SEEN_IN_MEMPOOL' ||
    status === 'REORG_ORPHANED'
  )
}

export function humanTxStatus(status: TxStatus): string {
  switch (status) {
    case 'DRAFT':
      return 'Draft'
    case 'VALIDATING':
      return 'Validating'
    case 'BROADCASTING':
      return 'Broadcasting'
    case 'SEEN_IN_MEMPOOL':
      return 'In mempool'
    case 'MINED':
      return 'Confirmed'
    case 'FAILED_REJECTED':
      return 'Rejected'
    case 'REORG_ORPHANED':
      return 'Orphaned'
  }
}

export function humanDiagnostic(code: TxDiagnosticCode): string {
  switch (code) {
    case 'DUST_OUTPUT':
      return 'Output is below the dust limit'
    case 'INVALID_SATOSHIS':
      return 'Amount must be a whole number of satoshis'
    case 'INSUFFICIENT_FUNDS':
      return 'Not enough spendable balance'
    case 'EMPTY_INPUTS':
      return 'No inputs selected'
    case 'FEE_TOO_LOW':
      return 'Fee rate is too low for the network'
    case 'SCRIPT_INVALID':
      return 'Script validation failed'
    case 'PROTOCOL_REFUSE':
      return 'Protocol rules refused this send'
    case 'ARC_REJECTED':
      return 'Network rejected the transaction'
    case 'ARC_DOUBLE_SPEND':
      return 'Double-spend detected'
    case 'BUMP_UNVERIFIED':
      return 'Inclusion proof could not be verified'
    case 'REORG':
      return 'Block reorg orphaned this transaction'
    case 'UNKNOWN':
      return 'Unknown error'
  }
}
