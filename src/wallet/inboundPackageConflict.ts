/**
 * Is an inbound package already double-spent?
 *
 * SPV checks a package against itself and the headers: scripts, amounts,
 * proofs. It cannot see that a coin the package spends was already spent by
 * another transaction, so a sender's dead send verifies, internalizes and then
 * sits in the miners' orphan pool for ever. The receiver kept re-chasing it on
 * every inbox poll with the row on "Verifying…".
 *
 * Every input of every unmined transaction in the package is asked about at
 * once — a dead ancestor kills the subject as surely as a dead direct input.
 * A spender inside the package is the package itself, not a conflict.
 */
import { Beef } from '@bsv/sdk'
import type { Chain } from './vault'
import { probeOutpointSpends } from './createActionInputFate'
import type { PackageConflictFacts } from './kernel/inboundHintFate'

/** One Teranode request and a few WhatsOnChain batches. */
const MAX_PROBED_INPUTS = 60
/** A clean answer is re-asked after this long; a conflict is final. */
const CLEAN_RECHECK_MS = 10 * 60_000

type PackageInputs = { outpoints: string[]; members: Set<string> }

/** Inputs of the package's unmined transactions, the subject's first. */
export function unminedPackageInputs(atomic: number[], subject: string): PackageInputs | null {
  const id = subject.trim().toLowerCase()
  let beef: Beef
  try {
    beef = Beef.fromBinary(atomic)
  } catch {
    return null
  }
  const members = new Set(beef.txs.map((btx) => btx.txid.toLowerCase()))
  if (!members.has(id)) return null
  const unmined = beef.txs
    .filter((btx) => !btx.isTxidOnly && !btx.hasProof && btx.tx)
    .sort((a, b) => Number(b.txid === id) - Number(a.txid === id))
  const outpoints: string[] = []
  const seen = new Set<string>()
  for (const btx of unmined) {
    for (const input of btx.tx!.inputs) {
      const prev = String(input.sourceTXID ?? input.sourceTransaction?.id('hex') ?? '').toLowerCase()
      const vout = input.sourceOutputIndex
      if (!/^[0-9a-f]{64}$/.test(prev) || !Number.isInteger(vout) || vout < 0) continue
      const outpoint = `${prev}.${vout}`
      if (seen.has(outpoint)) continue
      seen.add(outpoint)
      outpoints.push(outpoint)
    }
  }
  return { outpoints: outpoints.slice(0, MAX_PROBED_INPUTS), members }
}

type Probe = typeof probeOutpointSpends

export async function findPackageConflict(
  atomic: number[],
  subject: string,
  chain: Chain,
  probe: Probe = probeOutpointSpends,
): Promise<PackageConflictFacts | null> {
  const inputs = unminedPackageInputs(atomic, subject)
  if (!inputs || inputs.outpoints.length === 0) return null
  const answers = await probe(inputs.outpoints, subject.trim().toLowerCase(), chain)
  for (const outpoint of inputs.outpoints) {
    const answer = answers.get(outpoint)
    if (answer?.kind !== 'spent') continue
    if (inputs.members.has(answer.spender)) continue
    return { outpoint, spender: answer.spender }
  }
  return null
}

const verdicts = new Map<string, { at: number; conflict: PackageConflictFacts | null }>()

/** A conflict already established for `txid` this session, if any. */
export function knownPackageConflict(txid: string): PackageConflictFacts | null {
  return verdicts.get(txid.trim().toLowerCase())?.conflict ?? null
}

/** {@link findPackageConflict}, asked at most once per {@link CLEAN_RECHECK_MS} per txid. */
export async function packageConflictFor(
  txid: string,
  atomic: number[],
  chain: Chain,
  now = Date.now(),
): Promise<PackageConflictFacts | null> {
  const id = txid.trim().toLowerCase()
  const prior = verdicts.get(id)
  if (prior?.conflict) return prior.conflict
  if (prior && now - prior.at < CLEAN_RECHECK_MS) return null
  const started = Date.now()
  const conflict = await findPackageConflict(atomic, id, chain).catch(() => null)
  const ms = Date.now() - started
  if (ms >= 250) console.info(`[tip-ingest] conflict-probe done ${ms}ms ${id.slice(0, 12)}`)
  verdicts.set(id, { at: now, conflict })
  return conflict
}

export function resetPackageConflictsForTests(): void {
  verdicts.clear()
}
