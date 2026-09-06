/**
 * Which durable `handcash.*` keys survive a factory wipe.
 *
 * Wallet wipe historically only cleared `handcash.brc100.*`. Caches and
 * outboxes under other prefixes (fungibles list, BRC-29 remittance outbox,
 * BRC-150 remittance map, cloud-backup watchdog, …) survived, so a “new”
 * wallet painted the previous King token and replayed foreign activity.
 *
 * Appearance / SFX / update mode / log upload URL are device prefs, not
 * wallet state — keep them across wipe.
 */

/** Exact keys that intentionally survive wipe. */
export const WIPE_SURVIVE_KEYS = new Set<string>([
  'handcash.appearance',
  'handcash.sfx.enabled',
  'handcash.logs.uploadUrl',
  'handcash.update.mode',
])

/** Prefixes that intentionally survive wipe (none today — reserved). */
export const WIPE_SURVIVE_PREFIXES: readonly string[] = []

export function shouldWipeHandcashKey(key: string): boolean {
  if (!key.startsWith('handcash.')) return false
  if (WIPE_SURVIVE_KEYS.has(key)) return false
  for (const prefix of WIPE_SURVIVE_PREFIXES) {
    if (key.startsWith(prefix)) return false
  }
  return true
}

/** Collect localStorage keys that a wipe must remove. */
export function listLocalHandcashKeysToWipe(
  storage: Pick<Storage, 'length' | 'key'> = localStorage,
): string[] {
  const keys: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (key && shouldWipeHandcashKey(key)) keys.push(key)
  }
  return keys
}
