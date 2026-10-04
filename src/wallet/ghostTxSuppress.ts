/**
 * Txids treated as dead locally (Arcade hard-reject, or later proven-dead).
 * Tip-hint polls must not keep re-pinning Activity "Verifying…" for those.
 * Explorer 404 alone is not enough — Arcade is tip validity truth.
 *
 * The newer verdict wins: a ghost mark clears the landed mark, and a landing
 * reported after a ghost mark outranks it.
 */
import { createDurableTtlTxidMap } from './durableTtlTxidMap'
import { forgetTxLanded, txLanded } from './landedTx'

const ghosts = createDurableTtlTxidMap({
  key: 'handcash.wallet.ghostTx.v1',
  max: 500,
  ttlMs: 30 * 24 * 60 * 60_000,
})

export function isGhostTxSuppressed(txid: string): boolean {
  return ghosts.has(txid) && !txLanded(txid)
}

export function rememberGhostTx(txid: string): void {
  ghosts.remember(txid)
  forgetTxLanded(txid)
}

export function forgetGhostTx(txid: string): void {
  ghosts.forget(txid)
}

export function __resetGhostTxSuppressForTests(): void {
  ghosts.reset()
}
