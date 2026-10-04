import { Beef } from '@bsv/sdk'

export const EMPTY_INPUT_BEEF: number[] = Array.from(new Beef().toBinary())

export type InputBeefFrame = {
  inputBEEF: number[]
  dropped: string[]
  /** Proof roots the chain tracker still has to accept, by block height. */
  roots: Record<number, string>
}

/**
 * The Toolbox runs `beef.verify(chainTracker, true)` over `inputBEEF` before it
 * reads storage, so one unproven body whose parents are absent refuses the
 * whole action ("valid Beef when factoring options.trustSelf"). Token parent
 * fills add exactly such bodies when a funding parent is unconfirmed change.
 *
 * Drop every body that cannot reach a proof inside the package, plus its
 * descendants. With `trustSelf: 'known'` the Toolbox reads storage-held inputs
 * instead; an input storage does not hold still fails closed by name there.
 */
export function verifiableInputBeef(binary: number[]): InputBeefFrame {
  const work = Beef.fromBinary(binary)
  work.atomicTxid = undefined
  const dropped: string[] = []
  for (let pass = 0; pass <= work.txs.length; pass++) {
    const sorted = work.sortTxs()
    const bad = [...sorted.withMissingInputs, ...sorted.notValid]
    if (bad.length === 0) break
    for (const txid of bad) {
      work.removeExistingTxid(txid)
      dropped.push(txid)
    }
  }
  const { valid, roots } = work.verifyValid(true)
  if (!valid) return { inputBEEF: EMPTY_INPUT_BEEF, dropped, roots: {} }
  return { inputBEEF: Array.from(work.toBinary()), dropped, roots }
}

/** The Toolbox's whole-package verify refused (structure or a proof root). */
export function isInputBeefRefusal(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '')
  return /inputBEEF/i.test(message) && /factoring options\.trustSelf/i.test(message)
}

export function describeInputBeefFrame(frame: InputBeefFrame): string {
  const n = frame.dropped.length
  const heights = Object.keys(frame.roots)
  const ids = n ? ` (${frame.dropped.map((t) => t.slice(0, 12)).join(', ')})` : ''
  const at = heights.length ? ` at ${heights.join(', ')}` : ''
  return `dropped ${n} unproven bod${n === 1 ? 'y' : 'ies'} without parents${ids}, ${heights.length} proof root(s)${at}`
}
