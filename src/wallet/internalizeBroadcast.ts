import { Transaction, type WalletInterface } from '@bsv/sdk'
import { withVisibleOnChainBeef } from './legacyBeef'
import { alreadyInternalizedError } from './peerIngestHelpers'
import { broadcastAtomicBeef } from './sendBrc29Payment'

function atomicBytes(args: unknown): number[] {
  const value =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as { tx?: unknown }).tx
      : undefined
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (byte) =>
        Number.isInteger(byte) &&
        Number(byte) >= 0 &&
        Number(byte) <= 255,
    )
  ) {
    throw new Error('The tx parameter must be valid AtomicBEEF')
  }
  return value.map(Number)
}

/** What this call credits: the requested output indexes, priced from the BEEF. */
function creditedSatoshis(transaction: Transaction, args: unknown): number {
  const outputs =
    args && typeof args === 'object' && Array.isArray((args as { outputs?: unknown }).outputs)
      ? (args as { outputs: Array<{ outputIndex?: unknown }> }).outputs
      : []
  let total = 0
  for (const output of outputs) {
    const index = Number(output?.outputIndex)
    if (!Number.isInteger(index) || index < 0) continue
    total += Number(transaction.outputs[index]?.satoshis || 0)
  }
  return total
}

/**
 * Import an app-supplied Atomic BEEF. The BEEF (plus remittance on the
 * BRC-100 call) is the exchange — SPV-valid locally. Arcade postBeef is a
 * propagation double-check and must not delay crediting the wallet.
 */
export async function internalizeActionWithBroadcast(
  wallet: WalletInterface,
  args: unknown,
  originator?: string,
): Promise<unknown> {
  const atomic = atomicBytes(args)
  const transaction = Transaction.fromAtomicBEEF(Uint8Array.from(atomic))
  const txid = transaction.id('hex')
  // A BRC-29 remittance names the output but not its value, and the toolbox
  // answers a bare `{ accepted: true }`. Activity, the receive sound and the
  // mobile notification are all driven off the credited amount, so a reply
  // without it left money that had already landed with no row and no
  // notification — the balance moved and nothing else did. We parsed the BEEF
  // to get here, so say what this call actually credited on every path.
  const satoshis = creditedSatoshis(transaction, args)

  let result: unknown
  try {
    const accepted = await withVisibleOnChainBeef(() =>
      wallet.internalizeAction(args as never, originator),
    )
    result = {
      ...(accepted && typeof accepted === 'object' && !Array.isArray(accepted)
        ? (accepted as unknown as Record<string, unknown>)
        : { accepted: true }),
      txid,
      satoshis,
    }
  } catch (error) {
    if (!alreadyInternalizedError(error)) throw error
    result = { accepted: true, isMerge: true, txid, satoshis }
  }

  void broadcastAtomicBeef(txid, atomic)
    .then((submitted) => {
      console.info(
        `[internalize] ${txid.slice(0, 12)}… credited locally arcadeSubmitted=${String(submitted)}`,
      )
    })
    .catch((err) => {
      console.warn(
        `[internalize] ${txid.slice(0, 12)}… Arcade double-check failed`,
        err instanceof Error ? err.message : String(err),
      )
    })
  return result
}
