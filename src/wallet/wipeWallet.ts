/**
 * Factory-reset local wallet: vault, prefs, IndexedDB UTXOs, in-memory session.
 * Requires password so an unlocked session cannot be wiped casually.
 */
import { unlockVault } from './vault'
import { clearActiveWallet } from './session'
import { cancelPendingPermissions, clearPermissionSession } from './permissions'
import { clearCollectablesCache } from './collectables'
import { durableForgetCached } from './durableStorage'

const KEY_PREFIX = 'handcash.brc100'
const PENDING_IDB_WIPE = 'handcash.brc100.pendingIdbWipe'

function wipeLocalStorage(): number {
  let removed = 0
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith(KEY_PREFIX)) keys.push(key)
    }
    for (const key of keys) {
      localStorage.removeItem(key)
      removed++
    }
  } catch {
    // private mode / quota
  }
  // A wipe must not leave cached reads answering for keys that no longer exist.
  durableForgetCached()
  return removed
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(name)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
      req.onblocked = () => {
        // Open connections (toolbox) often block until reload — finish after relaunch.
        resolve()
      }
    } catch {
      resolve()
    }
  })
}

function shouldWipeDb(name: string): boolean {
  return (
    name.startsWith('handcash-brc100') ||
    name.startsWith('wallet-toolbox') ||
    name.includes('wallet-toolbox')
  )
}

export async function wipeIndexedDatabases(): Promise<string[]> {
  const wiped: string[] = []
  if (typeof indexedDB === 'undefined') return wiped

  const known = ['wallet-toolbox-mainnet', 'wallet-toolbox-testnet']
  for (const name of known) {
    await deleteDatabase(name)
    wiped.push(name)
  }

  if (typeof indexedDB.databases === 'function') {
    try {
      const dbs = await indexedDB.databases()
      for (const db of dbs) {
        if (!db.name || !shouldWipeDb(db.name)) continue
        if (wiped.includes(db.name)) continue
        await deleteDatabase(db.name)
        wiped.push(db.name)
      }
    } catch {
      // Chromium may deny databases() enumeration
    }
  }

  return wiped
}

/** Run on boot if a wipe was requested while toolbox DBs were still open. */
export async function finishPendingWalletWipe(): Promise<void> {
  try {
    if (sessionStorage.getItem(PENDING_IDB_WIPE) !== '1') return
  } catch {
    return
  }
  await wipeIndexedDatabases()
  wipeLocalStorage()
  try {
    sessionStorage.removeItem(PENDING_IDB_WIPE)
  } catch {
    // ignore
  }
}

/**
 * Destroy all local wallet data after password check, then reload into onboarding.
 */
export async function wipeAllWalletData(password: string): Promise<void> {
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters')
  }

  // Prove the operator knows the unlock password before destroying keys.
  await unlockVault(password)

  try {
    sessionStorage.setItem(PENDING_IDB_WIPE, '1')
  } catch {
    // ignore
  }

  cancelPendingPermissions('wipe')
  clearPermissionSession()
  clearActiveWallet()
  clearCollectablesCache()

  wipeLocalStorage()
  await wipeIndexedDatabases()

  if (window.handcash?.wipeWalletStorage) {
    await window.handcash.wipeWalletStorage()
  }

  wipeLocalStorage()
}
