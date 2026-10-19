import type { ChainTracker, MerklePath } from '@bsv/sdk'
import { getActiveWallet } from './session'

/**
 * SPV finality gate — MINED only after BUMP/TSC verifies against local headers.
 *
 * Uses the wallet's chain tracker (Chaintracks + failover). Unknown height ≠
 * forged proof; callers treat `unknown` as "keep SEEN_IN_MEMPOOL".
 */

export type SpvFinalityResult =
  | { ok: true; height: number }
  | { ok: false; reason: 'no_wallet' | 'no_proof' | 'invalid' | 'unknown' | 'error'; detail?: string }

/** The two service calls finality needs, as the toolbox's `Services` provides them. */
type FinalityServices = {
  getMerklePath?: (txid: string) => Promise<{ merklePath?: MerklePath } | null | undefined>
  getChainTracker?: () => Promise<ChainTracker>
}

/**
 * Verify inclusion for `txid` using toolbox merkle path + chain tracker.
 * Hard finality requires a definitive `true` from path.verify.
 */
export async function verifyBumpFinality(txid: string): Promise<SpvFinalityResult> {
  const needle = txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(needle)) {
    return { ok: false, reason: 'no_proof', detail: 'invalid txid' }
  }

  const active = getActiveWallet()
  if (!active) return { ok: false, reason: 'no_wallet' }

  try {
    const services = active.services as FinalityServices
    if (typeof services?.getMerklePath !== 'function' || typeof services.getChainTracker !== 'function') {
      return { ok: false, reason: 'unknown', detail: 'merkle/chainTracker unavailable' }
    }

    const path = (await services.getMerklePath(needle))?.merklePath
    if (!path) return { ok: false, reason: 'no_proof' }

    const height = Number.isFinite(path.blockHeight) ? Math.trunc(path.blockHeight) : null
    if (height == null || height <= 0) {
      return { ok: false, reason: 'unknown', detail: 'missing block height' }
    }

    const valid = await path.verify(needle, await services.getChainTracker())
    if (valid === true) return { ok: true, height }
    if (valid === false) return { ok: false, reason: 'invalid' }
    return { ok: false, reason: 'unknown', detail: 'chainTracker behind or inconclusive' }
  } catch (err) {
    return {
      ok: false,
      reason: 'error',
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}
