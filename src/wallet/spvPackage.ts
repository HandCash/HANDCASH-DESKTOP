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
 * next package: it gets a single-leaf proof whose root is its own txid, and
 * the tracker below vouches for exactly those roots. A single-leaf root is a
 * coinbase txid, never a wallet txid, so no real block can collide.
 *
 * The script engine reads the UTXO height from that proof and picks the
 * consensus rules for it. Height 0 is pre-Genesis: an executed `OP_RETURN`
 * (the MAP suffix of a minted 1Sat) and any script over 10 KB fail there, so
 * a fresh mint could never be listed. The stand-in sits just deep enough for
 * coinbase maturity below the tracker's tip, under today's rules — where an
 * unmined source is evaluated too.
 */
import { Beef, MerklePath, type ChainTracker, type Transaction } from '@bsv/sdk'
import {
  classifySpvThrow,
  SPV_SCRIPT_FAILED,
  type SpvVerdict,
} from './kernel/spvVerdict'

const VERIFIED_MAX = 5_000
/** A single-leaf proof is a coinbase, which the SDK spends only 100 blocks deep. */
const COINBASE_MATURITY = 100
/** `@bsv/verifast` POST_CHRONICLE_HEIGHT_FALLBACK — not exported by the package. */
const POST_CHRONICLE_HEIGHT = 943_816
const verified = new Set<string>()

async function standInHeight(tracker: ChainTracker): Promise<number> {
  try {
    const tip = await tracker.currentHeight()
    if (Number.isSafeInteger(tip) && tip >= COINBASE_MATURITY) return tip - COINBASE_MATURITY
  } catch {
    // An unreachable tip fails the maturity check in verify as `incomplete`.
  }
  return POST_CHRONICLE_HEIGHT
}

function trackerVouchingVerified(inner: ChainTracker, standIn: number): ChainTracker {
  return {
    isValidRootForHeight: async (root, height) =>
      (height === standIn && verified.has(root.toLowerCase())) ||
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
function unminedGraph(subject: Transaction, standIn: number): string[] {
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
      tx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(id, standIn)
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
  const standIn = await standInHeight(tracker)
  const unmined = unminedGraph(subject, standIn)
  let verdict: SpvVerdict
  try {
    verdict = (await subject.verify(trackerVouchingVerified(tracker, standIn)))
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
