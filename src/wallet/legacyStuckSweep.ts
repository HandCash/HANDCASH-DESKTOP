/**
 * Reclaim legacy sweeps that were marked imported but never reached a miner.
 *
 * The sweep runs through the toolbox in delayed mode, so a reported success only
 * means the transaction was accepted locally. If it never reached a miner, the
 * deposit sits unspent behind a permanent mark and no other code path can free
 * it — that is a received payment the wallet will never credit.
 *
 * An address scan still listing the input as unspent proves nothing on its own;
 * providers lag our own broadcast by minutes, and re-sweeping on that alone
 * double-spends the first sweep. So the recorded txid must be provably missing.
 * When the provider will not answer, the mark stands.
 *
 * Shared by the own-address ingest and the imported-phrase sweep: both reach
 * `importLegacyUtxos` through the same durable guard, so both must be able to
 * heal it the same way.
 */
import { txExistsOnChain } from './legacyScan'
import { legacySweepRecord, legacySweepRetryEligible } from './legacyImportGuard'
import type { Chain } from './vault'

export async function retryableStuckSweeps(
  utxos: Array<{ outpoint: string }>,
  chain: Chain,
): Promise<string[]> {
  const candidates = utxos
    .map((u) => u.outpoint.trim().toLowerCase())
    .filter((op) => {
      if (!op || !legacySweepRetryEligible(op)) return false
      // No recorded sweep txid means no evidence either way. The original version
      // of this heal treated that as retryable, and re-sweeping on a hunch is what
      // booked one deposit three times. Absent proof, the mark stands.
      return !!legacySweepRecord(op)?.txid
    })
  if (candidates.length === 0) return []

  const { mapPool } = await import('./asyncPool')
  const flags = await mapPool(candidates, 4, async (op) => {
    const txid = legacySweepRecord(op)?.txid
    if (!txid) return null
    if ((await txExistsOnChain(txid, chain)) !== false) return null
    return op
  })
  return flags.filter((op): op is string => !!op)
}
