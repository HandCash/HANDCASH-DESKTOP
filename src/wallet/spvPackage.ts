/**
 * Full SPV of a signed package, on this device, before any miner sees it.
 *
 * `Transaction.verify` walks the package: scripts and amounts for every
 * unmined tx, merkle proofs against the header sources for every mined one.
 * The wallet's chain tracker throws when no source can serve a header, so
 * "not known yet" stays `incomplete` and never reads as a bad proof.
 *
 * A chain of change payments re-verifies the same unmined parents on every
 * send, so a tx already verified here stands in for its own subtree on the
 * next package: it gets a height-0 single-leaf proof whose root is its own
 * txid, and the tracker below vouches for exactly those roots. Genesis is the
 * only real block at height 0 and its root is never a wallet txid.
 */
import { Beef, MerklePath, type ChainTracker, type Transaction } from '@bsv/sdk'
import {
  classifySpvThrow,
  SPV_SCRIPT_FAILED,
  type SpvVerdict,
} from './kernel/spvVerdict'

const VERIFIED_MAX = 5_000
const VERIFIED_HEIGHT = 0
const verified = new Set<string>()

function trackerVouchingVerified(inner: ChainTracker): ChainTracker {
  return {
    isValidRootForHeight: async (root, height) =>
      (height === VERIFIED_HEIGHT && verified.has(root.toLowerCase())) ||
      inner.isValidRootForHeight(root, height),
    currentHeight: () => inner.currentHeight(),
  }
}

/** This device SPV-verified the tx (and its unmined ancestry) this session. */
export function spvVerifiedHere(txid: string): boolean {
  return verified.has(txid.trim().toLowerCase())
}

export function resetSpvPackageForTests(): void {
  verified.clear()
}

function rememberVerified(txids: Iterable<string>): void {
  for (const txid of txids) {
    verified.delete(txid)
    verified.add(txid)
  }
  while (verified.size > VERIFIED_MAX) {
    const oldest = verified.values().next()
    if (oldest.done === true) break
    verified.delete(oldest.value)
  }
}

/** Unmined txs of the package, subject first; seals ones already verified. */
function unminedGraph(subject: Transaction): string[] {
  const unmined: string[] = []
  const seen = new Set<Transaction>()
  const queue: Transaction[] = [subject]
  while (queue.length > 0) {
    const tx = queue.shift()!
    if (seen.has(tx)) continue
    seen.add(tx)
    if (typeof tx.merklePath === 'object') continue
    const id = tx.id('hex')
    if (tx !== subject && verified.has(id)) {
      tx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(id, VERIFIED_HEIGHT)
      continue
    }
    unmined.push(id)
    for (const input of tx.inputs) {
      if (input.sourceTransaction) queue.push(input.sourceTransaction)
    }
  }
  return unmined
}

export async function verifySignedPackage(
  beefBytes: number[],
  txid: string,
  tracker: ChainTracker | null | undefined,
): Promise<SpvVerdict> {
  const id = txid.trim().toLowerCase()
  if (!tracker) return { kind: 'incomplete', reason: 'no chain tracker' }
  let subject: Transaction | undefined
  try {
    subject = Beef.fromBinary(beefBytes).findAtomicTransaction(id)
  } catch (err) {
    return { kind: 'incomplete', reason: `unreadable package: ${String(err).slice(0, 160)}` }
  }
  if (!subject || subject.id('hex') !== id) {
    return { kind: 'incomplete', reason: 'package does not carry this tx' }
  }
  const started = Date.now()
  const unmined = unminedGraph(subject)
  let verdict: SpvVerdict
  try {
    verdict = (await subject.verify(trackerVouchingVerified(tracker)))
      ? { kind: 'verified' }
      : SPV_SCRIPT_FAILED
  } catch (err) {
    verdict = classifySpvThrow(err)
  }
  if (verdict.kind === 'verified') rememberVerified(unmined)
  const ms = Date.now() - started
  if (ms >= 250) {
    console.info(`[spv] ${id.slice(0, 12)} verify txs=${unmined.length} done ${ms}ms`)
  }
  return verdict
}
