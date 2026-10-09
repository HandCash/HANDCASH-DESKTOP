/**
 * Import tips this wallet already sealed under one of its own transactions.
 *
 * A seal names the local transaction that spends the tip. The pre-signing input
 * check trusts it, so a tip sealed by an import leg that never reached a miner
 * (the renderer died between signing and the miner queue) was refused on every
 * build — 85s per batch on 0.1.676 — while the chain still listed it unspent.
 *
 * That leg is a signed cheque: it is cashed, never replaced. On chain, its tips
 * are gone. With a signed body, it goes to miners: accepted, its tips are moved
 * by it; hard-rejected, minerSubmit releases the seal and the tips are built
 * again. Anything undecided waits for the next run instead of being refused.
 */
import { Beef, Transaction } from '@bsv/sdk'
import { normalizeOutpointKey } from '../txLifecycle'

export type SealerFate =
  /** The sealing transaction is on chain: its tips left the phrase address. */
  | { kind: 'onChain' }
  /** Miners took the sealing transaction just now; it moves its tips. */
  | { kind: 'pushed'; tx: Transaction | null }
  /** The seal is gone (hard reject): the tips are free to build again. */
  | { kind: 'released' }
  /** Nothing decided — no body, no answer, or still queued. */
  | { kind: 'held'; reason: string }

export type SealerPorts = {
  sealedSpenderOf: (outpoint: string) => string | null
  txExistsOnChain: (txid: string) => Promise<boolean | null>
  /** Atomic BEEF of a local signed transaction, or null when none is stored. */
  signedBody: (txid: string, tipTxids: string[]) => Promise<number[] | null>
  /** Resolves on acceptance or a queued retry; throws on a hard reject. */
  submit: (txid: string, atomic: number[]) => Promise<{ kind: string; reason?: string }>
}

export type SealedTipsResult<T> = {
  /** Not sealed by any transaction. */
  free: T[]
  /** Sealed by a transaction miners hard-rejected just now: build these again. */
  released: T[]
  /** Moved by an earlier leg of this wallet, with the tx that moved each. */
  moved: Array<{ item: T; txid: string; vout?: number }>
  /** The sealing transaction is on chain: these left the phrase address. */
  gone: T[]
  /** Sealed under a transaction still undecided; try again next run. */
  held: T[]
  /** Fate of each sealing transaction, by txid. */
  sealers: Map<string, SealerFate>
}

export async function settleSealedTips<T extends { outpoint: string; txid: string }>(
  items: readonly T[],
  destLockHex: string,
  ports: SealerPorts,
): Promise<SealedTipsResult<T>> {
  const result: SealedTipsResult<T> = { free: [], released: [], moved: [], gone: [], held: [], sealers: new Map() }
  const bySealer = new Map<string, T[]>()
  for (const item of items) {
    const sealer = ports.sealedSpenderOf(item.outpoint)
    if (!sealer) {
      result.free.push(item)
      continue
    }
    bySealer.set(sealer, [...(bySealer.get(sealer) ?? []), item])
  }
  for (const [sealer, tips] of bySealer) {
    const fate = await sealerFate(sealer, tips, ports)
    result.sealers.set(sealer, fate)
    if (fate.kind === 'onChain') result.gone.push(...tips)
    else if (fate.kind === 'released') result.released.push(...tips)
    else if (fate.kind === 'held') result.held.push(...tips)
    else {
      const vouts = tipVouts(fate.tx, destLockHex)
      for (const item of tips) {
        const vout = vouts.get(normalizeOutpointKey(item.outpoint))
        result.moved.push({ item, txid: sealer, ...(vout !== undefined ? { vout } : {}) })
      }
    }
  }
  return result
}

async function sealerFate<T extends { outpoint: string; txid: string }>(
  sealer: string,
  tips: readonly T[],
  ports: SealerPorts,
): Promise<SealerFate> {
  if ((await ports.txExistsOnChain(sealer).catch(() => null)) === true) return { kind: 'onChain' }
  const body = await ports.signedBody(sealer, [...new Set(tips.map((t) => t.txid))]).catch(() => null)
  if (!body?.length) return { kind: 'held', reason: 'no signed body on this device' }
  try {
    const submitted = await ports.submit(sealer, body)
    if (submitted.kind === 'accepted') return { kind: 'pushed', tx: txOf(body, sealer) }
    return { kind: 'held', reason: `${submitted.kind}${submitted.reason ? ` (${submitted.reason})` : ''}` }
  } catch (err) {
    const stillSealed = tips.some((t) => ports.sealedSpenderOf(t.outpoint) === sealer)
    if (!stillSealed) return { kind: 'released' }
    return { kind: 'held', reason: err instanceof Error ? err.message : String(err) }
  }
}

function txOf(atomic: number[], txid: string): Transaction | null {
  try {
    return Beef.fromBinary(atomic).findTxid(txid)?.tx ?? null
  } catch {
    return null
  }
}

/**
 * Output holding each tip in an item-migrate leg. The leg names its tips as its
 * first inputs and pays each to `destLockHex`, one sat, in the same order.
 */
function tipVouts(tx: Transaction | null, destLockHex: string): Map<string, number> {
  const out = new Map<string, number>()
  if (!tx) return out
  const want = destLockHex.toLowerCase()
  const dest: number[] = []
  tx.outputs.forEach((output, vout) => {
    if (output.satoshis === 1 && output.lockingScript.toHex().toLowerCase() === want) dest.push(vout)
  })
  tx.inputs.forEach((input, i) => {
    if (i >= dest.length) return
    const source = input.sourceTXID ?? input.sourceTransaction?.id('hex')
    if (source) out.set(normalizeOutpointKey(`${source}.${input.sourceOutputIndex}`), dest[i]!)
  })
  return out
}
