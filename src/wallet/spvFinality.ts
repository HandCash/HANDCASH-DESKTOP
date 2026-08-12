/**
 * SPV finality gate — MINED only after BUMP/TSC verifies against local headers.
 *
 * Uses the wallet's chainTracker (Chaintracks + failover). Unknown height ≠
 * forged proof; callers treat `unknown` as "keep SEEN_IN_MEMPOOL".
 */
import { getActiveWallet } from './session'

export type SpvFinalityResult =
  | { ok: true; height: number }
  | { ok: false; reason: 'no_wallet' | 'no_proof' | 'invalid' | 'unknown' | 'error'; detail?: string }

type MerklePathLike = {
  blockHeight?: number
  verify?: (
    txid: string,
    chainTracker: { isValidRootForHeight: (root: string, height: number) => Promise<boolean | null | undefined> },
  ) => Promise<boolean | null | undefined>
}

/**
 * Verify inclusion for `txid` using toolbox merkle path + chainTracker.
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
    const services = active.services as {
      getMerklePath?: (txid: string) => Promise<MerklePathLike | null | undefined>
      chainTracker?: {
        isValidRootForHeight: (root: string, height: number) => Promise<boolean | null | undefined>
      }
    }
    if (!services?.getMerklePath || !services.chainTracker) {
      return { ok: false, reason: 'unknown', detail: 'merkle/chainTracker unavailable' }
    }

    const path = await services.getMerklePath(needle)
    if (!path) return { ok: false, reason: 'no_proof' }

    const height =
      typeof path.blockHeight === 'number' && Number.isFinite(path.blockHeight)
        ? Math.trunc(path.blockHeight)
        : null
    if (height == null || height <= 0) {
      return { ok: false, reason: 'unknown', detail: 'missing block height' }
    }

    if (typeof path.verify !== 'function') {
      return { ok: false, reason: 'unknown', detail: 'path.verify unavailable' }
    }

    const valid = await path.verify(needle, services.chainTracker)
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
