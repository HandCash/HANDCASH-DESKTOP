/**
 * Pin signed txs that reached Arcade on the initial postBeef round.
 *
 * Arcade often returns false doubleSpends / missing-inputs when a tx is still
 * local. Once Arcade accepted the send, it is not cancelable, not removable
 * from Activity, and inputs stay sealed until chain proof shows the spend failed.
 */
import { spentStatusOfOutpoint, txExistsOnChain } from './legacyScan'
import type { Chain } from './vault'
import { createDurableTtlTxidMap } from './durableTtlTxidMap'
import { inputOutpointsForSignedTx } from './signedTxInputs'
import { normalizeTxid } from './txid'
import {
  postBeefResultsArcadeAccepted,
  postBeefResultsArcadeHardReject,
  postBeefResultsHitArcade,
} from './postBeefResult'

export {
  postBeefResultsArcadeAccepted,
  postBeefResultsArcadeHardReject,
  postBeefResultsHitArcade,
}

const pins = createDurableTtlTxidMap({
  key: 'handcash.wallet.arcadeSubmit.v1',
  max: 500,
  ttlMs: 14 * 24 * 60 * 60_000,
})

export function rememberArcadeSubmitContact(txid: string): void {
  pins.remember(txid)
}

export function txHadArcadeSubmitContact(txid: string): boolean {
  return pins.has(txid)
}

/** Any pinned send at all. Heal uses this to decide the pending scan is worth
 *  running when the projected balance shows no pending change — Arcade-pinned
 *  `nosend` change is stranded outside both spendable and pendingChange. */
export function hasArcadeSubmitContacts(): boolean {
  return pins.size() > 0
}

export function forgetArcadeSubmitContact(txid: string): void {
  pins.forget(txid)
}

/**
 * True only when chain/indexer proof shows this signed tx cannot still land:
 * our tx is not on chain and at least one input is spent elsewhere.
 * Inconclusive indexer silence returns false (keep the row + sealed inputs).
 */
export async function signedTxSpendConflictIsProven(args: {
  txid: string
  atomic?: number[]
  chain: Chain
  knownOnChain?: boolean | null
}): Promise<boolean> {
  const txid = normalizeTxid(args.txid)
  if (!txid) return false

  const onChain =
    args.knownOnChain !== undefined
      ? args.knownOnChain
      : await txExistsOnChain(txid, args.chain).catch(() => null)
  if (onChain === true) return false

  const inputs = await inputOutpointsForSignedTx(txid, args.atomic)
  if (inputs.length === 0) return false

  const statuses = await Promise.all(
    inputs.map((op) => spentStatusOfOutpoint(op, args.chain).catch(() => 'unknown' as const)),
  )
  if (statuses.some((s) => s === 'unknown')) return false
  return statuses.some((s) => s === 'spent')
}

/**
 * Whether Activity / sealed inputs may treat this signed send as dead.
 *
 * A locally SPV-valid signed transaction is a cheque. Explorer absence is
 * latency, not a cancel. Only a proven competing spend (our tx not on chain
 * and an input spent by someone else) undoes it.
 */
export async function signedTxMayBeRemoved(args: {
  txid: string
  atomic?: number[]
  chain: Chain
}): Promise<boolean> {
  if (!txHadArcadeSubmitContact(args.txid)) return true
  return signedTxSpendConflictIsProven(args)
}

/**
 * Whether a signed spend was abandoned before it ever reached a broadcaster.
 *
 * Without an Arcade pin nobody else holds this cheque, so if it is absent on
 * chain and every input is still unspent, its sealed inputs and change are
 * stranded for no reason. See `kernel/abandonedSpendFate` for the rules.
 */
export async function signedTxLooksAbandoned(args: {
  txid: string
  atomic?: number[]
  chain: Chain
  createdAt: number
  knownOnChain?: boolean | null
}): Promise<boolean> {
  const txid = normalizeTxid(args.txid)
  if (!txid) return false

  const { decideAbandonedSpend, ABANDON_GRACE_MS } = await import(
    './kernel/abandonedSpendFate'
  )
  const hasArcadeContact = txHadArcadeSubmitContact(txid)
  // Cheap facts first — an explorer fan-out per sealed tx per heal pass is not
  // worth spending on a cheque we are going to keep anyway.
  if (hasArcadeContact) return false
  if (!(args.createdAt > 0) || Date.now() - args.createdAt < ABANDON_GRACE_MS) {
    return false
  }

  const onChain =
    args.knownOnChain !== undefined
      ? args.knownOnChain
      : await txExistsOnChain(txid, args.chain).catch(() => null)
  if (onChain !== false) return false

  const outpoints = await inputOutpointsForSignedTx(txid, args.atomic)
  const inputs = await Promise.all(
    outpoints.map((op) =>
      spentStatusOfOutpoint(op, args.chain).catch(() => 'unknown' as const),
    ),
  )

  const fate = decideAbandonedSpend({
    hasArcadeContact,
    onChain,
    inputs,
    createdAt: args.createdAt,
    now: Date.now(),
  })
  return fate.kind === 'abandoned'
}

export function __resetArcadeSubmitGuardForTests(): void {
  pins.reset()
}
