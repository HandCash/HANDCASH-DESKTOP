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

  let result: unknown
  try {
    result = await withVisibleOnChainBeef(() =>
      wallet.internalizeAction(args as never, originator),
    )
  } catch (error) {
    if (!alreadyInternalizedError(error)) throw error
    const outputIndexes =
      args && typeof args === 'object' && Array.isArray((args as { outputs?: unknown }).outputs)
        ? ((args as { outputs: Array<{ outputIndex?: unknown }> }).outputs)
            .map((output) => Number(output?.outputIndex))
            .filter((index) => Number.isInteger(index) && index >= 0)
        : []
    const satoshis = outputIndexes.reduce(
      (sum, index) => sum + Number(transaction.outputs[index]?.satoshis || 0),
      0,
    )
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
