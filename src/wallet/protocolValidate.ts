/**
 * Protocol-aware validation middleware — runs *before* optimistic UTXO locks
 * or ARC broadcast. Fail closed with diagnostic codes; never mutate UTXOs here.
 */
import type { TxDiagnosticCode } from './txLifecycle'

/** BSV dust floor for standard P2PKH outputs (sats). */
export const DUST_LIMIT_SATS = 1

/** Conservative minimum fee floor for tiny payments (sats). Not a rate oracle. */
export const MIN_FEE_FLOOR_SATS = 1

export type ProtocolValidateInput = {
  satoshis: number
  /** Available spendable sats (integer) before this send. */
  availableSats: number
  /** Optional estimated fee; when omitted, only dust + funds checks run. */
  feeSats?: number
  /** Selected input outpoints — empty fails closed. */
  inputOutpoints?: string[]
  /** Protocol path already refused (TipKind / SendPath refuse). */
  protocolRefuse?: boolean
  protocolRefuseDetail?: string
}

export type ProtocolValidateResult =
  | { ok: true }
  | { ok: false; code: TxDiagnosticCode; detail: string }

/**
 * Pure local checks. Callers map `ok: false` → FAILED_REJECTED without locking.
 */
export function validateBeforeOptimisticLock(
  input: ProtocolValidateInput,
): ProtocolValidateResult {
  if (input.protocolRefuse) {
    return {
      ok: false,
      code: 'PROTOCOL_REFUSE',
      detail: input.protocolRefuseDetail?.trim() || 'Protocol refused this path',
    }
  }

  const sats = input.satoshis
  if (!Number.isFinite(sats) || !Number.isInteger(sats) || sats <= 0) {
    return {
      ok: false,
      code: 'INVALID_SATOSHIS',
      detail: 'Amount must be a positive integer satoshi value',
    }
  }

  if (sats < DUST_LIMIT_SATS) {
    return {
      ok: false,
      code: 'DUST_OUTPUT',
      detail: `Output ${sats} sat is below dust limit ${DUST_LIMIT_SATS}`,
    }
  }

  const available = Math.max(0, Math.trunc(input.availableSats))
  const fee =
    input.feeSats === undefined
      ? 0
      : Math.max(0, Math.trunc(input.feeSats))

  if (input.feeSats !== undefined && fee < MIN_FEE_FLOOR_SATS) {
    return {
      ok: false,
      code: 'FEE_TOO_LOW',
      detail: `Fee ${fee} sat is below floor ${MIN_FEE_FLOOR_SATS}`,
    }
  }

  if (available < sats + fee) {
    return {
      ok: false,
      code: 'INSUFFICIENT_FUNDS',
      detail: `Need ${sats + fee} sats, have ${available}`,
    }
  }

  if (input.inputOutpoints !== undefined && input.inputOutpoints.length === 0) {
    return {
      ok: false,
      code: 'EMPTY_INPUTS',
      detail: 'No UTXOs selected for this spend',
    }
  }

  return { ok: true }
}
