import { brc39BytesFromPackage, type PairingPackage } from './deviceLinkProtocol'
import { setHistoryBackupPrefs } from './historyBackupPrefs'
import { importBrc39IntoActiveWallet } from './historyBackup'
import { clearImportedLegacyOutpoints } from './legacyImportGuard'
import { bootWallet, clearActiveWallet, fetchBalanceSats } from './session'
import { syncLegacyFunds } from './syncFunds'
import { restoreVaultFromRootKey, type UnlockedVault } from './vault'

export type ApplyLinkedWalletResult = {
  unlocked: UnlockedVault
  balanceSats: number
  historyRestored: boolean
}

/**
 * Install a scanned pairing package: vault from root key, merge BRC-39 history
 * when present, then legacy address sync for any leftover P2PKH coins.
 */
export async function applyLinkedWallet(
  pkg: PairingPackage,
  password: string,
): Promise<ApplyLinkedWalletResult> {
  clearActiveWallet()
  clearImportedLegacyOutpoints()

  const unlocked = await restoreVaultFromRootKey({
    rootKeyHex: pkg.rootKeyHex,
    password,
    chain: pkg.chain,
    handle: pkg.handle || undefined,
  })

  if (pkg.historyBackupBaseUrl) {
    setHistoryBackupPrefs({ baseUrl: pkg.historyBackupBaseUrl })
  }

  const active = await bootWallet({
    rootKeyHex: unlocked.rootKeyHex,
    handle: unlocked.record.handle,
    chain: unlocked.record.chain,
  })

  let historyRestored = false
  const brc39 = brc39BytesFromPackage(pkg)
  if (brc39 && pkg.brc39Password) {
    try {
      await importBrc39IntoActiveWallet(brc39, pkg.brc39Password, 'merge')
      historyRestored = true
    } catch (err) {
      console.warn('[link] BRC-39 import failed', err)
      throw new Error(
        err instanceof Error
          ? `Wallet keys installed but history import failed: ${err.message}`
          : 'Wallet keys installed but history import failed',
      )
    }
  }

  let balanceSats = 0
  try {
    balanceSats = await fetchBalanceSats(active.wallet)
    const synced = await syncLegacyFunds({ announceReceive: false, forceRescan: true })
    if (synced != null) balanceSats = synced
  } catch (err) {
    console.warn('[link] post-link sync failed', err)
  }

  return { unlocked, balanceSats, historyRestored }
}
