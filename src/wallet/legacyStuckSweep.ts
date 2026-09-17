/**
 * Reclaim legacy import marks that never recorded a signed transaction.
 *
 * The sweep runs through the toolbox in delayed mode, so a reported success only
 * means the transaction was accepted locally. Once a txid exists it is a signed
 * cheque and must keep propagating; this helper never creates a competing sweep.
 *
 * An address scan still listing the input as unspent proves nothing on its own;
 * providers lag our own broadcast by minutes, and re-sweeping on that alone
 * double-spends the first sweep. Explorer absence cannot cancel it.
 *
 * Shared by the own-address ingest and the imported-phrase sweep: both reach
 * `importLegacyUtxos` through the same durable guard, so both must be able to
 * heal it the same way.
 */
import { legacySweepRecord, legacySweepRetryEligible } from './legacyImportGuard'
import type { Chain } from './vault'

export async function retryableStuckSweeps(
  utxos: Array<{ outpoint: string }>,
  _chain: Chain,
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

  // A recorded txid is a signed cheque. Explorer absence cannot authorize a
  // competing sweep; keep those marks and continue propagating the original.
  void withTxid
  return withoutTxid
}
