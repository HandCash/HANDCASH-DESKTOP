import { storageRegistry } from '../storage/registry'
import { durableGetItem } from './durableStorage'

const KEY = storageRegistry.vaultSealStatus.key

/** Electron sets this when OS seal fails and vault is stored unsealed. */
export function isVaultStoredUnsealed(): boolean {
  return durableGetItem(KEY) === 'unsealed'
}

export function getVaultSealStatus(): 'sealed' | 'unsealed' | 'unknown' {
  const raw = durableGetItem(KEY)
  if (raw === 'unsealed') return 'unsealed'
  if (raw === 'sealed') return 'sealed'
  return 'unknown'
}
