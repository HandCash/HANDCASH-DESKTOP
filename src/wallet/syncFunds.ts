import { scanLegacyAddress, importLegacyUtxos } from './legacyScan'
import { getActiveWallet, fetchBalanceSats } from './session'
import { reconcilePendingSends } from './pendingSend'
import { classifyLegacyUtxos, importOneSatOrdinals } from './oneSatImport'

/**
 * Quietly scan the legacy receive address and import UTXOs.
 * 1Sat ordinals → basket `1sat` (internalize). Other P2PKH → managed change.
 * Safe to call on an interval; failures are logged only.
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
      const { funding, oneSats, heldOneSats } = await classifyLegacyUtxos(
        scan.utxos,
        active.chain,
      )
      if (heldOneSats.length > 0) {
        console.info(
          `[sync] holding ${heldOneSats.length} unrecognized one-sat out(s) — not sweeping`,
        )
      }
      if (oneSats.length > 0) {
        const itemResult = await importOneSatOrdinals(oneSats, active)
        if (itemResult.failed > 0) {
          console.warn('[sync] 1sat import partial', itemResult)
        }
      }
      if (funding.length > 0) {
        const result = await importLegacyUtxos(funding, active)
        if (result.failed > 0) {
          console.warn('[sync] legacy import partial', result)
        }
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
