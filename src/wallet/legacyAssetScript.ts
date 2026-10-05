/**
 * Script facts a legacy sweep needs before it may touch an output.
 *
 * A RUN jig is a bare P2PKH output: nothing in its own script says it is an
 * asset. The jig state lives in the `run` OP_RETURN marker of the transaction
 * that created it, and spending the output without a RUN transaction destroys
 * the jig. So the question "is this a jig?" is answered from the whole source
 * transaction, never from the output alone.
 */
import { Utils, type Transaction } from '@bsv/sdk'

/** `OP_FALSE? OP_RETURN <"run">` — the RUN protocol marker. */
const RUN_MARKER = /^(?:00)?6a0372756e/

function readPushes(bytes: number[]): number[][] {
  const pushes: number[][] = []
  let at = 0
  while (at < bytes.length) {
    const op = bytes[at]!
    let length: number
    let start: number
    if (op >= 1 && op <= 75) {
      length = op
      start = at + 1
    } else if (op === 0x4c) {
      length = bytes[at + 1] ?? 0
      start = at + 2
    } else if (op === 0x4d) {
      length = (bytes[at + 1] ?? 0) | ((bytes[at + 2] ?? 0) << 8)
      start = at + 3
    } else if (op === 0x4e) {
      length =
        ((bytes[at + 1] ?? 0) |
          ((bytes[at + 2] ?? 0) << 8) |
          ((bytes[at + 3] ?? 0) << 16) |
          ((bytes[at + 4] ?? 0) << 24)) >>>
        0
      start = at + 5
    } else {
      at += 1
      continue
    }
    if (start + length > bytes.length) break
    pushes.push(bytes.slice(start, start + length))
    at = start + length
  }
  return pushes
}

function runOutputCount(markerHex: string, markerLength: number): number | null {
  const pushes = readPushes(Utils.toArray(markerHex.slice(markerLength), 'hex'))
  const payload = pushes.at(-1)
  if (!payload) return null
  try {
    const json = JSON.parse(Utils.toUTF8(payload)) as { out?: unknown }
    return Array.isArray(json.out) ? json.out.length : null
  } catch {
    return null
  }
}

/**
 * Output indexes of `tx` that carry RUN jigs.
 *
 * Jigs follow the marker, one per entry of the payload's `out` list. When the
 * payload cannot be read, every output after the marker counts as a jig: a
 * held change output costs nothing, a swept jig is gone.
 */
export function runJigVouts(tx: Pick<Transaction, 'outputs'> | null | undefined): Set<number> {
  const jigs = new Set<number>()
  if (!tx) return jigs
  const last = tx.outputs.length - 1
  tx.outputs.forEach((output, markerVout) => {
    const hex = output.lockingScript?.toHex().toLowerCase() ?? ''
    const marker = RUN_MARKER.exec(hex)
    if (!marker) return
    const count = runOutputCount(hex, marker[0].length)
    const end = count == null ? last : Math.min(last, markerVout + count)
    for (let vout = markerVout + 1; vout <= end; vout += 1) jigs.add(vout)
  })
  return jigs
}

/** Exactly `OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG`. */
export function isBareP2pkhScript(lockingScriptHex: string | null | undefined): boolean {
  return /^76a914[0-9a-f]{40}88ac$/.test((lockingScriptHex ?? '').trim().toLowerCase())
}
