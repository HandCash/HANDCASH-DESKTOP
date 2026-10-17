import { Beef } from '@bsv/sdk'
import type { ActiveWallet } from '../session'
import { getBeefForTxidCached } from '../beefCache'

export type TokenTipLineage =
  | { ok: true; tokenId: string; beef: Beef }
  | { ok: false; reason: string }

/**
 * BRC-176 walk of a token output to its deploy, every token spend
 * script-checked, before this wallet pays for it. Missing parent bodies are
 * filled from the local cache first; the caller never takes an index's word
 * for a token's history.
 */
export async function proveTokenTipLineage(
  active: ActiveWallet,
  outpoint: string,
  beefBytes: number[] | Uint8Array,
): Promise<TokenTipLineage> {
  const { fillTokenParentBodies, proveWithScripts } = await import('./prove176')
  const { provenTokenDeployOf } = await import('./lineage')
  const point = outpoint.trim().toLowerCase().replace('.', '_')
  let beef = Beef.fromBinary(Array.from(beefBytes))
  let proof = proveWithScripts(point, beef, provenTokenDeployOf)
  if (!proof.ok) {
    beef = await fillTokenParentBodies(
      beef,
      async (txid) => {
        try {
          return await getBeefForTxidCached(active, txid, {
            needProof: false,
            allowUnprovenRawTx: true,
          })
        } catch {
          return null
        }
      },
      [point.slice(0, 64)],
      provenTokenDeployOf,
    )
    proof = proveWithScripts(point, beef, provenTokenDeployOf)
  }
  if (!proof.ok) return { ok: false, reason: proof.reason }
  return { ok: true, tokenId: proof.tokenId.toLowerCase(), beef }
}
