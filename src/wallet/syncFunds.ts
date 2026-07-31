import { scanLegacyAddress, importLegacyUtxos } from './legacyScan'
import { getActiveWallet, fetchBalanceSats } from './session'
import { reconcilePendingSends } from './pendingSend'
import { classifyLegacyUtxos, importOneSatOrdinals } from './oneSatImport'
import { playWalletSound } from './soundService'

export type SyncLegacyFundsOptions = {
  /**
   * When true (default), play receive SFX only if spendable balance rises
   * (or a newly seen 1sat outpoint is internalized). Pass false after a local
   * send so we don't double-chime with payment success.
   */
  announceReceive?: boolean
}

/** Outpoints we've already chimed for this session — avoids re-import noise. */
const announcedOneSatOutpoints = new Set<string>()
let lastReceiveChimeAt = 0
const RECEIVE_CHIME_COOLDOWN_MS = 12_000

function maybeReceiveChime(): void {
  const now = Date.now()
  if (now - lastReceiveChimeAt < RECEIVE_CHIME_COOLDOWN_MS) return
  lastReceiveChimeAt = now
  playWalletSound('receive')
}

/**
 * Quietly scan the legacy receive address and import UTXOs.
 * 1Sat ordinals → basket `1sat` (internalize). Other P2PKH → managed change.
 * Safe to call on an interval; failures are logged only.
 *
 * Important for self-sends: createAction pays your receive address as an
 * "external" output, so balance drops until those UTXOs are imported back.
 */
export async function syncLegacyFunds(
  opts?: SyncLegacyFundsOptions,
): Promise<number | null> {
  const announceReceive = opts?.announceReceive !== false
  const active = getActiveWallet()
  if (!active) return null

  let balanceBefore = 0
  let balanceBeforeOk = false
  try {
    balanceBefore = await fetchBalanceSats(active.wallet)
    balanceBeforeOk = true
  } catch {
    balanceBefore = 0
  }

  try {
    reconcilePendingSends()
  } catch (err) {
    console.warn('[sync] pending send reconcile skipped', err)
  }

  let newOneSatOutpoints: string[] = []

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
        newOneSatOutpoints = (itemResult.outpoints ?? []).filter(
          (op) => !announcedOneSatOutpoints.has(op),
        )
        for (const op of itemResult.outpoints ?? []) {
          announcedOneSatOutpoints.add(op)
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
    const balanceAfter = await fetchBalanceSats(active.wallet)
    if (announceReceive) {
      // Only chime on a real spendable balance increase. Do NOT key off
      // import success counts — re-import / no-op success is common on the
      // 30s poll and was causing intermittent receive SFX while idle.
      const balanceRose = balanceBeforeOk && balanceAfter > balanceBefore
      const newItems = newOneSatOutpoints.length > 0
      if (balanceRose || newItems) {
        maybeReceiveChime()
      }
    }
    return balanceAfter
  } catch (err) {
    console.warn('[sync] balance refresh failed', err)
    return null
  }
}
