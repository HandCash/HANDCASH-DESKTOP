/**
 * What this wallet has proven about its own coins.
 *
 * SPV proves a parent exists. Nothing short of a node's UTXO set proves a coin
 * unspent — except that only this key can spend it. So the wallet keeps two
 * facts, and forgets each the moment its own ledger could make it false:
 *
 * - **cleared** outpoint: an explorer answered "no tx spends this". It stands
 *   until this wallet signs over the coin; every sign forgets its inputs, so a
 *   coin handed back by a failed send is asked about again instead of trusted.
 * - **certified** tx: signed only from coins proven unspent. Its change is good
 *   by induction for as long as the tx is not failed or proven dead.
 *
 * The cleared TTL bounds the one spender the ledger cannot see: this key on
 * another install.
 */
import { createDurableTtlTxidMap } from './durableTtlTxidMap'

const OUTPOINT_RE = /^([0-9a-f]{64})[._:](\d+)$/

export function canonicalOutpoint(raw: string): string | null {
  const m = String(raw ?? '').trim().toLowerCase().match(OUTPOINT_RE)
  if (!m) return null
  const vout = Number(m[2])
  return Number.isSafeInteger(vout) ? `${m[1]}.${vout}` : null
}

const cleared = createDurableTtlTxidMap({
  key: 'handcash.wallet.clearedCoins.v1',
  max: 1_000,
  ttlMs: 6 * 60 * 60_000,
  normalize: canonicalOutpoint,
})

const certified = createDurableTtlTxidMap({
  key: 'handcash.wallet.certifiedTx.v1',
  max: 2_000,
  ttlMs: 14 * 24 * 60 * 60_000,
})

export function coinCleared(outpoint: string): boolean {
  return cleared.has(outpoint)
}

export function noteCoinsCleared(outpoints: Iterable<string>): void {
  cleared.rememberMany(outpoints)
}

export function forgetClearedCoins(outpoints: Iterable<string>): void {
  cleared.forgetMany(outpoints)
}

export function txCertified(txid: string): boolean {
  return certified.has(txid)
}

/** The tx spent `inputs`; they are no longer this wallet's to call unspent. */
export function noteTxCertified(txid: string, inputs: Iterable<string>): void {
  certified.remember(txid)
  forgetClearedCoins(inputs)
}

export function forgetTxCertified(txid: string): void {
  certified.forget(txid)
}

export function resetClearedCoinsForTests(): void {
  cleared.reset()
}

export function resetSpendCertaintyForTests(): void {
  cleared.reset()
  certified.reset()
}
