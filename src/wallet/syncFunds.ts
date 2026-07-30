import { scanLegacyAddress, importLegacyUtxos } from './legacyScan'
import { getActiveWallet, fetchBalanceSats } from './session'
import { reconcilePendingSends } from './pendingSend'

/**
 * Quietly scan the legacy receive address and import any UTXOs into
 * managed wallet balance. Safe to call on an interval; failures are logged only.
 *
 * Important for self-sends: createAction pays your receive address as an
 * "external" output, so balance drops until those UTXOs are imported back.
 */
export async function syncLegacyFunds(): Promise<number | null> {
  const active = getActiveWallet()
  if (!active) return null

  try {
    reconcilePendingSends()
  } catch (err) {
    console.warn('[sync] pending send reconcile skipped', err)
  }

  try {
    const scan = await scanLegacyAddress(active)
    if (scan.utxos.length > 0) {
      const outpoints = scan.utxos.map((u) => u.outpoint)
      const result = await importLegacyUtxos(outpoints, active)
      if (result.failed > 0) {
        console.warn('[sync] legacy import partial', result)
      }
    }
  } catch (err) {
    console.warn('[sync] legacy scan/import skipped', err)
  }

  try {
    return await fetchBalanceSats(active.wallet)
  } catch (err) {
    console.warn('[sync] balance refresh failed', err)
    return null
  }
}
