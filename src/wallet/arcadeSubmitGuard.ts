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
import { decideArcadePinFate, type ArcadeVerdict } from './kernel/arcadePinFate'
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

/**
 * Transactions Arcade has objectively rejected. Terminal, so it is remembered
 * rather than re-asked: a rejected transaction never becomes mineable.
 */
const rejections = createDurableTtlTxidMap({
  key: 'handcash.wallet.arcadeRejected.v1',
  max: 500,
  ttlMs: 30 * 24 * 60 * 60_000,
})

/** Non-terminal verdicts, cached briefly so a sweep does not re-ask per row. */
const verdictProbe = new Map<string, { at: number; verdict: ArcadeVerdict }>()
const VERDICT_PROBE_TTL_MS = 10 * 60_000

export function rememberArcadeSubmitContact(txid: string): void {
  pins.remember(txid)
}

export function txHadArcadeSubmitContact(txid: string): boolean {
  return pins.has(txid)
}

/**
 * Record Arcade's rejection of a transaction we submitted, and retire the pin
 * it issued. Both halves matter: the pin is what holds the Activity row and
 * the sealed inputs, and nothing else will ever release it for this tx.
 */
export function noteArcadeRejectedTx(txid: string): void {
  const id = normalizeTxid(txid)
  if (!id) return
  rejections.remember(id)
  verdictProbe.delete(id)
  pins.forget(id)
}

export function txIsArcadeRejected(txid: string): boolean {
  return rejections.has(txid)
}

/** Arcade's verdict on a transaction, memoised. Network silence is `unknown`. */
export async function arcadeVerdictFor(
  txid: string,
  chain: Chain,
): Promise<ArcadeVerdict> {
  const id = normalizeTxid(txid)
  if (!id) return 'unknown'
  if (rejections.has(id)) return 'rejected'
  const cached = verdictProbe.get(id)
  if (cached && Date.now() - cached.at < VERDICT_PROBE_TTL_MS) {
    return cached.verdict
  }

  const { fetchArcadeTxFate } = await import('./arcadeV2')
  const fate = await fetchArcadeTxFate(chain, id)
  const verdict: ArcadeVerdict =
    fate.kind === 'rejected'
      ? 'rejected'
      : fate.kind === 'accepted'
        ? 'accepted'
        : fate.kind === 'retryable'
          ? 'pending'
          : 'unknown'
  if (verdict === 'rejected') {
    console.warn(
      `[arcade] ${id.slice(0, 12)} rejected — ${fate.kind === 'rejected' ? fate.reason : ''}`,
    )
    noteArcadeRejectedTx(id)
    return verdict
  }
  verdictProbe.set(id, { at: Date.now(), verdict })
  return verdict
}

/**
 * Whether the Arcade pin still holds this signed transaction in place.
 *
 * Asked before any path that keeps a row or its sealed coins on the strength
 * of the pin alone. Arcade is only consulted when a pin exists.
 */
export async function arcadePinStillBinds(
  txid: string,
  chain: Chain,
): Promise<boolean> {
  const id = normalizeTxid(txid)
  if (!id || !pins.has(id)) return false
  if (rejections.has(id)) return false
  const verdict = await arcadeVerdictFor(id, chain).catch(
    () => 'unknown' as const,
  )
  return decideArcadePinFate({ hasPin: true, verdict }).kind === 'binds'
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
 * latency, not a cancel. A proven competing spend (our tx not on chain and an
 * input spent by someone else) undoes it — and so does Arcade rejecting the
 * cheque it pinned, which is the one refusal no chain evidence can ever show.
 */
export async function signedTxMayBeRemoved(args: {
  txid: string
  atomic?: number[]
  chain: Chain
}): Promise<boolean> {
  if (!txHadArcadeSubmitContact(args.txid)) return true
  if (!(await arcadePinStillBinds(args.txid, args.chain))) return true
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
  /**
   * Prevouts this transaction sealed, from our own lock records.
   *
   * A signed spend that never landed frequently has no raw body in storage —
   * the same gap that leaves its change unscripted — so the BEEF/raw route
   * returns nothing and the decision would stall on "inputs unknown" forever.
   */
  knownInputs?: string[]
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

  const fromBody = await inputOutpointsForSignedTx(txid, args.atomic)
  const outpoints = fromBody.length > 0 ? fromBody : (args.knownInputs ?? [])
  // One lookup per funding tx, not per input — a bulk send names the same
  // unlanded parent many times over.
  const parentOnChain = new Map<string, Promise<boolean | null>>()
  const inputs = await Promise.all(
    outpoints.map(async (op) => {
      const status = await spentStatusOfOutpoint(op, args.chain).catch(
        () => 'unknown' as const,
      )
      if (status !== 'unknown') return status
      // An outpoint can read unknown because its funding tx never landed. That
      // is not missing information — a nonexistent output is unspendable by
      // anyone, so this spend can never become valid.
      const parent = normalizeTxid(op.split(/[._:]/)[0] ?? '')
      if (!parent) return status
      let lookup = parentOnChain.get(parent)
      if (!lookup) {
        lookup = txExistsOnChain(parent, args.chain).catch(() => null)
        parentOnChain.set(parent, lookup)
      }
      return (await lookup) === false ? ('phantom' as const) : status
    }),
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
  rejections.reset()
  verdictProbe.clear()
}
