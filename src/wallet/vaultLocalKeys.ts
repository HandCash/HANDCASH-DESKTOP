/**
 * Durable keys for settings that belong to the vault, not to one sub-account.
 *
 * Backup policy is vault-wide: the key backup covers the master every account
 * derives from, and the backup host / confirmation must not change when the
 * user switches accounts. These live in the master account's namespace, so
 * every sub-account reads and writes the same value. Per-account backup
 * *state* (last upload, high-water, watchdog) stays on `accountLocalKey`.
 */
import { accountLocalKey, accountLocalKeyFor, peekAccountLocalKeyScope } from './accountLocalKeys'
import { readVaultMeta } from './vault'

export function vaultLocalKey(base: string): string {
  const masterIdentityKey = readVaultMeta()?.identityKey
  if (!masterIdentityKey) return accountLocalKey(base)
  return accountLocalKeyFor(base, {
    accountIndex: 0,
    identityKey: masterIdentityKey,
    chain: peekAccountLocalKeyScope().chain,
  })
}
