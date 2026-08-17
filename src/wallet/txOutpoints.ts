/**
 * Prevout keys from a signed transaction body.
 *
 * Toolbox stores dotted `txid.vout`; the overlay uses underscore keys. Callers
 * that talk to indexers keep the dotted form; {@link normalizeOutpointKey}
 * maps either into the overlay.
 */
import { Beef, Transaction } from '@bsv/sdk'

function pushInput(
  out: string[],
  prev: string,
  vout: number | undefined,
): void {
  const txid = prev.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isInteger(vout) || (vout ?? -1) < 0) {
    return
  }
  out.push(`${txid}.${vout}`)
}

/** Inputs of a raw (non-BEEF) transaction. */
export function inputOutpointsFromRawTx(raw: number[]): string[] {
  try {
    const tx = Transaction.fromBinary(raw)
    const out: string[] = []
    for (const input of tx.inputs) {
      const prev = String(
        input.sourceTXID ?? input.sourceTransaction?.id('hex') ?? '',
      )
      pushInput(out, prev, input.sourceOutputIndex)
    }
    return out
  } catch {
    return []
  }
}

/** Inputs of the named tx inside Atomic BEEF. */
export function inputOutpointsFromAtomicBeef(
  atomic: number[],
  txid: string,
): string[] {
  const id = txid.trim().toLowerCase()
  if (!atomic.length || !/^[0-9a-f]{64}$/.test(id)) return []
  try {
    const beef = Beef.fromBinary(atomic)
    const tx = beef.findTxid(id)?.tx ?? beef.findAtomicTransaction(id)
    if (!tx) return inputOutpointsFromRawTx(atomic)
    const out: string[] = []
    for (const input of tx.inputs) {
      const prev = String(
        input.sourceTXID ?? input.sourceTransaction?.id('hex') ?? '',
      )
      pushInput(out, prev, input.sourceOutputIndex)
    }
    return out
  } catch {
    return inputOutpointsFromRawTx(atomic)
  }
}

export function outpointFromOutput(row: {
  txid?: unknown
  vout?: unknown
  outputIndex?: unknown
}): string | null {
  const txid = String(row.txid ?? '')
    .trim()
    .toLowerCase()
  const vout = Number(row.vout ?? row.outputIndex)
  if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isInteger(vout) || vout < 0) {
    return null
  }
  return `${txid}.${vout}`
}
