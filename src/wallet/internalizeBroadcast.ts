import { Transaction, type WalletInterface } from '@bsv/sdk'
import { withVisibleOnChainBeef } from './legacyBeef'
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
 * Validate and import an app-supplied transaction, then hand the exact Atomic
 * BEEF to Arcade/miner services. A transaction body is sufficient for local
 * ingestion; WhatsOnChain visibility is eventual evidence, not a receive gate.
 */
export async function internalizeActionWithBroadcast(
  wallet: WalletInterface,
  args: unknown,
  originator?: string,
): Promise<unknown> {
  const atomic = atomicBytes(args)
  const transaction = Transaction.fromAtomicBEEF(Uint8Array.from(atomic))
  const txid = transaction.id('hex')

  const result = await withVisibleOnChainBeef(() =>
    wallet.internalizeAction(args as never, originator),
  )

  const submitted = await broadcastAtomicBeef(txid, atomic)
  console.info(
    `[internalize] ${txid.slice(0, 12)}… accepted locally arcadeSubmitted=${String(submitted)}`,
  )
  return result
}
