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
  const withTxid: string[] = []
  const withoutTxid: string[] = []
  for (const u of utxos) {
    const op = u.outpoint.trim().toLowerCase()
    if (!op || !legacySweepRetryEligible(op)) continue
    const record = legacySweepRecord(op)
    if (!record) continue
    if (record.txid) {
      withTxid.push(op)
      continue
    }
    // v1 marks and sweeps that never recorded a txid: the mark blocked every
    // retry with no way to heal. Still seeing the outpoint on the address scan
    // (this function only runs for outs in `funding`) is the honest signal we
    // never swept it — unlike a recorded txid, there is nothing to look up on
    // chain, so forget the mark and let importLegacyUtxos try once.
    withoutTxid.push(op)
  }

  const { mapPool } = await import('./asyncPool')
  const provedMissing = (
    await mapPool(withTxid, 4, async (op) => {
      const txid = legacySweepRecord(op)?.txid
      if (!txid) return null
      if ((await txExistsOnChain(txid, chain)) !== false) return null
      return op
    })
  ).filter((op): op is string => !!op)
  return [...provedMissing, ...withoutTxid]
}
