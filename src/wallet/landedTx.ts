/**
 * Txids Arcade or a node reported on the network. A device-wide fact: one
 * account's landed send is the same transaction another account received.
 */
import { createDurableTtlTxidMap } from './durableTtlTxidMap'

const landed = createDurableTtlTxidMap({
  key: 'handcash.wallet.arcadeLanded.v1',
  max: 1_000,
  ttlMs: 14 * 24 * 60 * 60_000,
})

export function txLanded(txid: string): boolean {
  return landed.has(txid)
}

export function noteTxLanded(txid: string): void {
  landed.remember(txid)
}

export function forgetTxLanded(txid: string): void {
  landed.forget(txid)
}

export function resetLandedTxForTests(): void {
  landed.reset()
}
