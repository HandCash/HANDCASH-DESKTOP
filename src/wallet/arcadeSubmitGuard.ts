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

export function __resetArcadeSubmitGuardForTests(): void {
  pins.reset()
}
