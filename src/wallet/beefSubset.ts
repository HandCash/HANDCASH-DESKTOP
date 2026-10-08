import { Beef, type BeefTx } from '@bsv/sdk'

/**
 * Several BEEF packages read as one, indexed by txid. An import decodes each
 * item's parents on its own: decoding one package for a whole import parsed
 * and hashed every inscription in a single call, which froze a phone for 5s.
 */
export class BeefShelf {
  private readonly byTxid = new Map<string, { beef: Beef; btx: BeefTx }>()

  add(beef: Beef): void {
    for (const btx of beef.txs) {
      const txid = btx.txid.toLowerCase()
      const held = this.byTxid.get(txid)
      // A body beats a bare txid; a proven copy beats an unproven one.
      if (held && (btx.isTxidOnly || (!held.btx.isTxidOnly && held.btx.bumpIndex !== undefined))) continue
      this.byTxid.set(txid, { beef, btx })
    }
  }

  locate(txid: string): { beef: Beef; btx: BeefTx } | undefined {
    return this.byTxid.get(txid.toLowerCase())
  }

  findTxid(txid: string): BeefTx | undefined {
    return this.locate(txid)?.btx
  }

  get size(): number {
    return this.byTxid.size
  }
}

type BeefSource = Beef | BeefShelf

function shelfOf(source: BeefSource): BeefShelf {
  if (source instanceof BeefShelf) return source
  const shelf = new BeefShelf()
  shelf.add(source)
  return shelf
}

/**
 * Walk `txids` and their unproven ancestors inside `source`, stopping at each
 * transaction that carries a BUMP. Txids the package does not hold are skipped:
 * the caller's own `createAction` names what it still lacks.
 */
function walkAncestry(
  source: BeefSource,
  txids: Iterable<string>,
  visit: (btx: BeefTx, beef: Beef) => void,
): void {
  const shelf = shelfOf(source)
  const seen = new Set<string>()
  const stack = [...txids].map((txid) => txid.toLowerCase())
  while (stack.length > 0) {
    const txid = stack.pop()!
    if (seen.has(txid)) continue
    seen.add(txid)
    const found = shelf.locate(txid)
    if (!found) continue
    const { btx, beef } = found
    visit(btx, beef)
    if (btx.isTxidOnly || btx.bumpIndex !== undefined) continue
    for (const parent of btx.inputTxids) stack.push(parent.toLowerCase())
  }
}

/**
 * The part of `source` that proves `txids`: each subject, every unproven
 * ancestor it holds, and the BUMPs those walks end on. One package built for a
 * whole import, merged into every leg, made each leg carry every other item's
 * mint transaction.
 */
export function beefSubset(source: BeefSource, txids: Iterable<string>): Beef {
  const out = new Beef()
  walkAncestry(source, txids, (btx, beef) => {
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
export function ancestryBytes(source: BeefSource, txid: string): Map<string, number> {
  const bytes = new Map<string, number>()
  walkAncestry(source, [txid], (btx) => {
    bytes.set(btx.txid.toLowerCase(), btx.isTxidOnly ? 32 : (btx.rawTx?.length ?? 0))
  })
  return bytes
}

/**
 * How many of `txids`, in order, fit one leg whose input package stays within
 * `budgetBytes`. Always at least one: a single tip over budget still gets its
 * own leg, and the durable queue names its refusal.
 */
export function prefixWithinBeefBudget(source: BeefSource, txids: readonly string[], budgetBytes: number): number {
  const shelf = shelfOf(source)
  const union = new Map<string, number>()
  let total = 0
  for (let i = 0; i < txids.length; i++) {
    let added = 0
    const fresh: Array<[string, number]> = []
    for (const [txid, size] of ancestryBytes(shelf, txids[i]!)) {
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
