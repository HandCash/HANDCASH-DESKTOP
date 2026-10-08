import { Beef, type BeefTx } from '@bsv/sdk'

/**
 * Walk `txids` and their unproven ancestors inside `beef`, stopping at each
 * transaction that carries a BUMP. Txids the package does not hold are skipped:
 * the caller's own `createAction` names what it still lacks.
 */
function walkAncestry(beef: Beef, txids: Iterable<string>, visit: (btx: BeefTx) => void): void {
  const seen = new Set<string>()
  const stack = [...txids].map((txid) => txid.toLowerCase())
  while (stack.length > 0) {
    const txid = stack.pop()!
    if (seen.has(txid)) continue
    seen.add(txid)
    const btx = beef.findTxid(txid)
    if (!btx) continue
    visit(btx)
    if (btx.isTxidOnly || btx.bumpIndex !== undefined) continue
    for (const parent of btx.inputTxids) stack.push(parent.toLowerCase())
  }
}

/**
 * The part of `beef` that proves `txids`: each subject, every unproven ancestor
 * the package holds, and the BUMPs those walks end on. One package built for a
 * whole import, merged into every leg, made each leg carry every other item's
 * mint transaction.
 */
export function beefSubset(beef: Beef, txids: Iterable<string>): Beef {
  const out = new Beef()
  walkAncestry(beef, txids, (btx) => {
    if (btx.isTxidOnly) {
      out.mergeTxidOnly(btx.txid)
      return
    }
    const raw = btx.rawTx
    if (!raw) return
    const bump = btx.bumpIndex !== undefined ? beef.bumps[btx.bumpIndex] : undefined
    out.mergeRawTx(raw, bump ? out.mergeBump(bump) : undefined)
  })
  out.sortTxs()
  return out
}

/** Raw bytes one txid's ancestry adds, keyed by txid so legs can dedupe shared parents. */
export function ancestryBytes(beef: Beef, txid: string): Map<string, number> {
  const bytes = new Map<string, number>()
  walkAncestry(beef, [txid], (btx) => {
    bytes.set(btx.txid.toLowerCase(), btx.isTxidOnly ? 32 : (btx.rawTx?.length ?? 0))
  })
  return bytes
}

/**
 * How many of `txids`, in order, fit one leg whose input package stays within
 * `budgetBytes`. Always at least one: a single tip over budget still gets its
 * own leg, and the durable queue names its refusal.
 */
export function prefixWithinBeefBudget(beef: Beef, txids: readonly string[], budgetBytes: number): number {
  const union = new Map<string, number>()
  let total = 0
  for (let i = 0; i < txids.length; i++) {
    let added = 0
    const fresh: Array<[string, number]> = []
    for (const [txid, size] of ancestryBytes(beef, txids[i]!)) {
      if (union.has(txid)) continue
      added += size
      fresh.push([txid, size])
    }
    if (i > 0 && total + added > budgetBytes) return i
    for (const [txid, size] of fresh) union.set(txid, size)
    total += added
  }
  return txids.length
}
