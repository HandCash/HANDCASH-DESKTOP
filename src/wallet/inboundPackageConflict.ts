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
/**
 * Off the send path, so it can wait for slow providers. The probe's 1.5s
 * spend-path default answered `unknown` for every coin from the phone WebView,
 * and the two dead receives were read as clean (hc-a580a, 0.1.664).
 */
const PROBE_TIMEOUT_MS = 10_000
/** Every coin answered and none conflicts: re-asked after this long. A conflict is final. */
const CLEAN_RECHECK_MS = 10 * 60_000
/** Some coins went unanswered: that is not a clean result, ask again soon. */
const PARTIAL_RECHECK_MS = 60_000

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

export type PackageProbe = {
  conflict: PackageConflictFacts | null
  asked: number
  spent: number
  unspent: number
  unknown: number
}

export async function probePackage(
  atomic: number[],
  subject: string,
  chain: Chain,
  probe: Probe = probeOutpointSpends,
): Promise<PackageProbe> {
  const tally: PackageProbe = { conflict: null, asked: 0, spent: 0, unspent: 0, unknown: 0 }
  const inputs = unminedPackageInputs(atomic, subject)
  if (!inputs || inputs.outpoints.length === 0) return tally
  tally.asked = inputs.outpoints.length
  const answers = await probe(inputs.outpoints, subject.trim().toLowerCase(), chain, PROBE_TIMEOUT_MS)
  for (const outpoint of inputs.outpoints) {
    const answer = answers.get(outpoint)
    if (answer?.kind === 'unspent') tally.unspent += 1
    if (answer?.kind !== 'spent') {
      if (answer?.kind !== 'unspent') tally.unknown += 1
      continue
    }
    tally.spent += 1
    if (inputs.members.has(answer.spender)) continue
    tally.conflict ??= { outpoint, spender: answer.spender }
  }
  return tally
}

export async function findPackageConflict(
  atomic: number[],
  subject: string,
  chain: Chain,
  probe: Probe = probeOutpointSpends,
): Promise<PackageConflictFacts | null> {
  return (await probePackage(atomic, subject, chain, probe)).conflict
}

const verdicts = new Map<
  string,
  { at: number; conflict: PackageConflictFacts | null; recheckMs: number }
>()

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
  if (prior && now - prior.at < prior.recheckMs) return null
  const started = Date.now()
  const result = await probePackage(atomic, id, chain).catch(
    (): PackageProbe => ({ conflict: null, asked: 0, spent: 0, unspent: 0, unknown: 1 }),
  )
  const ms = Date.now() - started
  console.info(
    `[tip-ingest] conflict-probe done ${ms}ms ${id.slice(0, 12)} asked=${result.asked} spent=${result.spent} unspent=${result.unspent} unknown=${result.unknown} conflict=${result.conflict ? result.conflict.spender.slice(0, 12) : 'none'}`,
  )
  verdicts.set(id, {
    at: now,
    conflict: result.conflict,
    recheckMs: result.unknown > 0 ? PARTIAL_RECHECK_MS : CLEAN_RECHECK_MS,
  })
  return result.conflict
}

export function resetPackageConflictsForTests(): void {
  verdicts.clear()
}
