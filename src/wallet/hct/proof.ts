import { Transaction } from '@bsv/sdk'
import { sourceTxidOf } from '../countersign/script'
import { checkHctTx, type HctDeploy } from './validity'

/**
 * BRC-255 §6 proof packages: the subject, the ancestors a recipient has not
 * validated, and the deploys it lacks, every one in Extended Format.
 */

export type HctPackage = { v: 1; subject: string; txs: string[]; deploys: string[] }

/** Plaintext a package may take before BRC-78 sealing, under the box host's 1 MiB body cap. */
export const HCT_PACKAGE_BUDGET = 600_000
/** Most transactions a received package may carry. */
export const MAX_PACKAGE_TXS = 5_000

const HEX = /^(?:[0-9a-f]{2})+$/i
const TXID = /^[0-9a-f]{64}$/

const idOf = (tx: Transaction) => String(tx.id('hex')).toLowerCase()

export type Ancestry = { ok: true; txs: Transaction[] } | { ok: false; txid: string; detail: string }

/**
 * Ancestors of `subject` the recipient needs for one asset, nearest first:
 * every transaction behind an asset input back to the deploy, an accepted
 * transaction (countersigned) or one the recipient already holds. The
 * sender re-checks §4 on each, so it never ships a history it would refuse.
 */
export async function hctAncestry(
  subject: Transaction,
  deploy: HctDeploy,
  txOf: (txid: string) => Promise<Transaction | null>,
  peerHolds: (txid: string) => boolean,
): Promise<Ancestry> {
  const out: Transaction[] = []
  const seen = new Set<string>([idOf(subject)])
  const queue: Transaction[] = [subject]
  while (queue.length > 0) {
    const tx = queue.shift()!
    const check = checkHctTx(tx, deploy)
    if (!check.ok) return { ok: false, txid: idOf(tx), detail: `${check.reason}: ${check.detail}` }
    if (check.accepted) continue
    for (const vin of check.inputs) {
      const parent = sourceTxidOf(tx, vin)
      if (seen.has(parent) || parent === deploy.txid || peerHolds(parent)) continue
      seen.add(parent)
      if (seen.size > MAX_PACKAGE_TXS) return { ok: false, txid: parent, detail: `history is over ${MAX_PACKAGE_TXS} transactions` }
      const parentTx = await txOf(parent)
      if (!parentTx) return { ok: false, txid: parent, detail: `transaction ${parent} is not available` }
      out.push(parentTx)
      queue.push(parentTx)
    }
  }
  return { ok: true, txs: out }
}

/**
 * Build a package within `budget`. Ancestors are nearest first, so a cut
 * keeps the hops a recipient is least likely to hold; it fetches the rest
 * from the chain or answers `need`. A deploy that does not fit is left out
 * the same way. `complete` says nothing was cut.
 */
export function buildHctPackage(
  subject: Transaction,
  ancestors: readonly Transaction[],
  deploys: readonly Transaction[],
  budget = HCT_PACKAGE_BUDGET,
): { pkg: HctPackage; complete: boolean } {
  const subjectEf = subject.toHexEF()
  const pkg: HctPackage = { v: 1, subject: idOf(subject), txs: [subjectEf], deploys: [] }
  let size = 64 + subjectEf.length
  let complete = true
  const seen = new Set<string>([pkg.subject])
  for (const tx of deploys) {
    const id = idOf(tx)
    if (seen.has(id)) continue
    seen.add(id)
    const ef = tx.toHexEF()
    if (size + ef.length + 3 > budget) {
      complete = false
      continue
    }
    pkg.deploys.push(ef)
    size += ef.length + 3
  }
  for (const tx of ancestors) {
    const id = idOf(tx)
    if (seen.has(id)) continue
    seen.add(id)
    const ef = tx.toHexEF()
    if (size + ef.length + 3 > budget) {
      complete = false
      break
    }
    pkg.txs.push(ef)
    size += ef.length + 3
  }
  return { pkg, complete }
}

export type ReadPackage = { subject: Transaction; txs: Map<string, Transaction>; deploys: Map<string, Transaction> }

function parseEf(hex: unknown): Transaction | null {
  if (typeof hex !== 'string' || !HEX.test(hex)) return null
  try {
    return Transaction.fromHexEF(hex)
  } catch {
    return null
  }
}

/** Strict read of a received package; null when any part is malformed. */
export function readHctPackage(value: unknown): ReadPackage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (v.v !== 1 || typeof v.subject !== 'string' || !TXID.test(v.subject)) return null
  if (!Array.isArray(v.txs) || v.txs.length === 0 || !Array.isArray(v.deploys)) return null
  if (v.txs.length + v.deploys.length > MAX_PACKAGE_TXS) return null
  const txs = new Map<string, Transaction>()
  let subject: Transaction | null = null
  for (const hex of v.txs) {
    const tx = parseEf(hex)
    if (!tx) return null
    subject ??= tx
    txs.set(idOf(tx), tx)
  }
  if (!subject || idOf(subject) !== v.subject) return null
  const deploys = new Map<string, Transaction>()
  for (const hex of v.deploys) {
    const tx = parseEf(hex)
    if (!tx) return null
    deploys.set(idOf(tx), tx)
  }
  return { subject, txs, deploys }
}
