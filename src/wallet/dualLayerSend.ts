/**
 * Dual-layer facade — begin optimistic send, advance ARC, SPV-mine, rollback.
 *
 * Call from send paths *alongside* existing bsv/soft-latch/BRC-29 machines.
 * Does not invent settle paths; only tracks confirmation + soft-locks.
 */
import { arcStatusFromPostBeef, handleArcRejection, parseArcStatus } from './arcStatusMap'
import { validateBeforeOptimisticLock } from './protocolValidate'
import type { PostBeefSummary } from './postBeefResult'
import { verifyBumpFinality } from './spvFinality'
import type { ArcStatus, TxDiagnosticCode, TxRecord } from './txLifecycle'
import {
  applyArcStatus,
  createDraftTx,
  getTxByTxid,
  getTxRecord,
  markTxFailed,
  markTxMined,
  markTxReorgOrphaned,
  transitionTx,
} from './txStore'
import {
  confirmSpentLocks,
  rollbackLocks,
  softLockInputs,
} from './utxoLockManager'

export type BeginDualLayerSendArgs = {
  satoshis: number
  availableSats: number
  to?: string | null
  feeSats?: number
  inputs?: Array<{ outpoint: string; satoshis: number }>
  protocolRefuse?: boolean
  protocolRefuseDetail?: string
  /** When true, skip soft-lock (toolbox createAction already reserves). */
  skipSoftLock?: boolean
}

export type BeginDualLayerSendResult =
  | { ok: true; record: TxRecord }
  | { ok: false; code: TxDiagnosticCode; detail: string; record?: TxRecord }

/** Validate → DRAFT/VALIDATING → optional soft-lock → BROADCASTING-ready. */
export function beginDualLayerSend(args: BeginDualLayerSendArgs): BeginDualLayerSendResult {
  const draft = createDraftTx({
    satoshis: args.satoshis,
    to: args.to,
    inputOutpoints: (args.inputs ?? []).map((i) => i.outpoint),
  })

  transitionTx(draft.id, 'VALIDATING')

  const validated = validateBeforeOptimisticLock({
    satoshis: args.satoshis,
    availableSats: args.availableSats,
    feeSats: args.feeSats,
    inputOutpoints: args.inputs?.map((i) => i.outpoint),
    protocolRefuse: args.protocolRefuse,
    protocolRefuseDetail: args.protocolRefuseDetail,
  })

  if (!validated.ok) {
    markTxFailed(draft.id, validated.code, validated.detail)
    return { ok: false, code: validated.code, detail: validated.detail, record: getTxRecord(draft.id) ?? draft }
  }

  if (!args.skipSoftLock && args.inputs && args.inputs.length > 0) {
    const locked = softLockInputs({
      lockOwnerId: draft.id,
      inputs: args.inputs,
    })
    if (!locked.ok) {
      markTxFailed(draft.id, 'PROTOCOL_REFUSE', locked.reason)
      return {
        ok: false,
        code: 'PROTOCOL_REFUSE',
        detail: locked.reason,
        record: getTxRecord(draft.id) ?? draft,
      }
    }
  }

  const broadcasting = transitionTx(draft.id, 'BROADCASTING')
  return { ok: true, record: broadcasting ?? getTxRecord(draft.id)! }
}

export function noteDualLayerTxid(id: string, txid: string): TxRecord | null {
  return transitionTx(id, 'BROADCASTING', { txid: txid.toLowerCase() })
}

/**
 * Register a transaction that was validated and signed by a protocol-specific
 * builder (items/tokens/market) rather than the ordinary payment preflight.
 *
 * Output construction remains in that protocol. From this point onward every
 * signed transaction has the same ARC + BUMP lifecycle as a BSV payment.
 */
export function beginSignedTxLifecycle(args: {
  txid: string
  satoshis: number
  to?: string | null
}): TxRecord {
  const existing = getTxByTxid(args.txid)
  if (existing) return existing
  const draft = createDraftTx({
    satoshis: args.satoshis,
    to: args.to,
  })
  transitionTx(draft.id, 'VALIDATING')
  // The signed body is already an unconfirmed cheque. Broadcast is how we
  // cash it; it is not a prerequisite for accounting the spend.
  return (
    transitionTx(draft.id, 'SEEN_IN_MEMPOOL', {
      txid: args.txid.trim().toLowerCase(),
      chainProof: 'unconfirmed',
    }) ?? getTxRecord(draft.id)!
  )
}

/** The common signed-cheque boundary for preflighted payment lifecycles. */
export function noteDualLayerSigned(id: string, txid: string): TxRecord | null {
  const withTxid = noteDualLayerTxid(id, txid)
  if (!withTxid) return null
  return transitionTx(id, 'SEEN_IN_MEMPOOL', { chainProof: 'unconfirmed' })
}

/** Advance from postBeef summary — mempool accept or hard reject + lock rollback. */
export function noteDualLayerPostBeef(id: string, summary: PostBeefSummary): TxRecord | null {
  const arc = arcStatusFromPostBeef(summary)
  return applyDualLayerArc(id, arc)
}

export function applyDualLayerArc(id: string, arc: ArcStatus | string): TxRecord | null {
  const status = typeof arc === 'string' ? parseArcStatus(arc) ?? (arc as ArcStatus) : arc
  const policy = handleArcRejection(status)
  const next = applyArcStatus(id, status)
  if (
    next?.status === 'SEEN_IN_MEMPOOL' ||
    next?.status === 'MINED' ||
    policy.shouldConfirmSpent
  ) {
    confirmSpentLocks(id, next?.txid ?? '')
  }
  if (policy.shouldRollbackLocks) {
    rollbackLocks(id)
  }
  return next
}

export function failDualLayerSend(
  id: string,
  code: TxDiagnosticCode,
  detail?: string | null,
  opts?: { hideInputs?: boolean },
): TxRecord | null {
  if (opts?.hideInputs) confirmSpentLocks(id, getTxRecord(id)?.txid ?? '')
  else rollbackLocks(id)
  return markTxFailed(id, code, detail)
}

/**
 * Attempt SPV finality. On verified BUMP → MINED + confirm locks.
 * On invalid → stay mempool / fail closed with diagnostic (no false MINED).
 */
export async function tryFinalizeDualLayerTx(id: string): Promise<TxRecord | null> {
  const rec = getTxRecord(id)
  if (!rec?.txid) return rec
  if (rec.status !== 'SEEN_IN_MEMPOOL' && rec.status !== 'BROADCASTING' && rec.status !== 'REORG_ORPHANED') {
    return rec
  }

  // Ensure we are at least in mempool before mining.
  if (rec.status === 'BROADCASTING') {
    transitionTx(id, 'SEEN_IN_MEMPOOL')
  }
  if (rec.status === 'REORG_ORPHANED') {
    transitionTx(id, 'SEEN_IN_MEMPOOL')
  }

  const proof = await verifyBumpFinality(rec.txid)
  if (proof.ok) {
    const mined = markTxMined(id, proof.height)
    confirmSpentLocks(id, rec.txid)
    return mined
  }
  if (proof.reason === 'invalid') {
    // Proof present but fails header check — do not mine; leave mempool with diagnostic.
    return transitionTx(id, 'SEEN_IN_MEMPOOL', {
      diagnostic: 'BUMP_UNVERIFIED',
      diagnosticDetail: proof.detail ?? 'invalid merkle proof',
    })
  }
  return getTxRecord(id)
}

export function orphanDualLayerTx(id: string): TxRecord | null {
  return markTxReorgOrphaned(id)
}
