/**
 * Txids treated as dead locally (Arcade hard-reject, or later proven-dead).
 * Tip-hint polls must not keep re-pinning Activity "Verifying…" for those.
 * Explorer 404 alone is not enough — Arcade is tip validity truth.
 */
import { createDurableTtlTxidMap } from './durableTtlTxidMap'

const ghosts = createDurableTtlTxidMap({
  key: 'handcash.wallet.ghostTx.v1',
  max: 500,
  ttlMs: 30 * 24 * 60 * 60_000,
})

export function isGhostTxSuppressed(txid: string): boolean {
  return ghosts.has(txid)
}

export function rememberGhostTx(txid: string): void {
  ghosts.remember(txid)
}

export function forgetGhostTx(txid: string): void {
  ghosts.forget(txid)
}

export function __resetGhostTxSuppressForTests(): void {
  ghosts.reset()
}
