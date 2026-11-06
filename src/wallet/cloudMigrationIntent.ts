/**
 * Onboarding chose Sign in / Migrate: after the local vault is ready, open
 * Settings → Import on the HandCash two-key form and the /migrate page so the
 * user can bring keys, handle, and holdings — never a silent custody drop.
 */

import { requestImportKind } from './import'
import { openSetting } from './navStore'
import { MIGRATE_LOGIN_URL } from './walletConfig'
import { storageRegistry } from '../storage/registry'
import { durableGetItem, durableRemoveItem, durableSetItem } from './durableStorage'

const KEY = storageRegistry.cloudMigrationIntent.key

/** Remember that create/onboard should finish into cloud migration import. */
export function armCloudMigrationIntent(): void {
  if (!durableSetItem(KEY, 'pending')) throw new Error('Could not save the migration checkpoint on this device.')
}

export function peekCloudMigrationIntent(): boolean {
  return durableGetItem(KEY) === 'pending'
}

/**
 * If armed, open HandCash import + /migrate and clear the arm.
 * Call once the wallet is unlocked after onboarding create.
 */
export function consumeCloudMigrationIntent(): boolean {
  if (!peekCloudMigrationIntent()) return false
  requestImportKind('handcash')
  openSetting('import')
  durableRemoveItem(KEY)
  if (typeof window !== 'undefined') {
    void window.handcash?.openExternal?.(MIGRATE_LOGIN_URL).catch(() => undefined)
  }
  return true
}

/** Test helper. */
export function resetCloudMigrationIntentForTests(): void {
  durableRemoveItem(KEY)
}

export function cancelCloudMigrationIntent(): void { durableRemoveItem(KEY) }
