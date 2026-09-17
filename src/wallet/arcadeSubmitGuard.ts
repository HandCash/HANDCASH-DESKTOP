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
}): Promise<boolean> {
  const txid = normalizeTxid(args.txid)
  if (!txid) return false

  const onChain = await txExistsOnChain(txid, args.chain).catch(() => null)
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
 * How long an Arcade pin outlives proof that the chain does not have the tx.
 *
 * The pin exists because Arcade's first answer is unreliable, not because Arcade
 * is the chain. Arcade also *keeps* transactions it refused: a `REJECTED` chain
 * ("parent rejected … / UTXO_SPENT") stays pinned forever, so its inputs were
 * resealed every pass and its Activity row could never be cleared — a dead spend
 * nursed as if it were in flight. Absence proven by chain providers wins once the
 * submit is older than this.
 */
export const ARCADE_PIN_ABSENCE_GRACE_MS = 10 * 60_000

/**
 * True when the chain positively does not have this pinned tx and the submit is
 * old enough that propagation lag is no longer a credible explanation.
 *
 * `txExistsOnChain` answers `false` only on real evidence — a provider that has
 * never heard of it answers `null`, and Arcade reports its own `REJECTED` as
 * absent. Silence therefore keeps the pin.
 */
async function pinnedTxProvenAbsent(args: {
  txid: string
  chain: Chain
  now?: number
}): Promise<boolean> {
  const txid = normalizeTxid(args.txid)
  if (!txid) return false
  const pinnedAt = pins.rememberedAt(txid)
  if (pinnedAt == null) return false
  const now = args.now ?? Date.now()
  if (now - pinnedAt < ARCADE_PIN_ABSENCE_GRACE_MS) return false
  const onChain = await txExistsOnChain(txid, args.chain).catch(() => null)
  return onChain === false
}

/** Whether Activity / sealed inputs may treat this signed send as dead. */
export async function signedTxMayBeRemoved(args: {
  txid: string
  atomic?: number[]
  chain: Chain
  now?: number
}): Promise<boolean> {
  if (!txHadArcadeSubmitContact(args.txid)) return true
  if (await signedTxSpendConflictIsProven(args)) return true
  return pinnedTxProvenAbsent(args)
}

export function __resetArcadeSubmitGuardForTests(): void {
  pins.reset()
}
