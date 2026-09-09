import { describe, expect, it } from 'vitest'
import {
  listLocalHandcashKeysToWipe,
  shouldWipeHandcashKey,
  WIPE_SURVIVE_KEYS,
} from './wipePolicy'

describe('wipePolicy', () => {
  it('keeps device prefs and clears wallet-state caches', () => {
    expect(shouldWipeHandcashKey('handcash.appearance')).toBe(false)
    expect(shouldWipeHandcashKey('handcash.sfx.enabled')).toBe(false)
    expect(shouldWipeHandcashKey('handcash.logs.uploadUrl')).toBe(false)
    expect(shouldWipeHandcashKey('handcash.update.mode')).toBe(false)

    expect(shouldWipeHandcashKey('handcash.brc100.vault.v1')).toBe(true)
    expect(shouldWipeHandcashKey('handcash.brc100.appActivity')).toBe(true)
    // These prefixes survived the old brc100-only wipe and caused ghost UI.
    expect(shouldWipeHandcashKey('handcash.fungibles.list.v1')).toBe(true)
    expect(shouldWipeHandcashKey('handcash.tokens.list.v1')).toBe(true)
    expect(shouldWipeHandcashKey('handcash.brc29.pendingOutbox.v1')).toBe(true)
    expect(shouldWipeHandcashKey('handcash.brc150.remittance.v1')).toBe(true)
    expect(shouldWipeHandcashKey('handcash.cloudBackup.watchdog.v1')).toBe(true)
    expect(shouldWipeHandcashKey('handcash.collectables.list.v1')).toBe(true)
    expect(shouldWipeHandcashKey('unrelated')).toBe(false)
  })

  it('lists only wipeable handcash keys from a Storage-like map', () => {
    const keys = [
      'handcash.appearance',
      'handcash.fungibles.list.v1',
      'handcash.brc29.pendingOutbox.v1',
      'handcash.logs.uploadUrl',
      'other.app',
    ]
    const storage = {
      length: keys.length,
      key: (i: number) => keys[i] ?? null,
    }
    const wipe = listLocalHandcashKeysToWipe(storage)
    expect(wipe.sort()).toEqual(
      ['handcash.brc29.pendingOutbox.v1', 'handcash.fungibles.list.v1'].sort(),
    )
    for (const kept of WIPE_SURVIVE_KEYS) {
      expect(wipe).not.toContain(kept)
    }
  })
})
