/**
 * Onboarding chose Sign in / Migrate: after the local vault is ready, open
 * Settings → Import on the HandCash two-key form and the /migrate page so the
 * user can bring keys, handle, and holdings — never a silent custody drop.
 */

import { requestImportKind } from './import'
import { openSetting } from './navStore'
import { MIGRATE_URL } from './walletConfig'

let pending = false

/** Remember that create/onboard should finish into cloud migration import. */
export function armCloudMigrationIntent(): void {
  pending = true
}

export function peekCloudMigrationIntent(): boolean {
  return pending
}

/**
 * If armed, open HandCash import + /migrate and clear the arm.
 * Call once the wallet is unlocked after onboarding create.
 */
export function consumeCloudMigrationIntent(): boolean {
  if (!pending) return false
  pending = false
  requestImportKind('handcash')
  openSetting('import')
  if (typeof window !== 'undefined') {
    void window.handcash?.openExternal?.(MIGRATE_URL)
    void window.handcash?.focusWindow?.()
  }
  return true
}

/** Test helper. */
export function resetCloudMigrationIntentForTests(): void {
  pending = false
}
