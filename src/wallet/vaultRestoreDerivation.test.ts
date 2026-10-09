import { beforeEach, describe, expect, it, vi } from 'vitest'

const durable = new Map<string, string>()
const choice = vi.hoisted(() => ({ used: new Set<string>(), unknown: false }))

vi.mock('./durableStorage.js', () => ({
  durableGetItem: (key: string) => durable.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    durable.set(key, value)
    return true
  },
}))
vi.mock('./vaultMasterChoice', async (importOriginal) => {
  const real = await importOriginal<typeof import('./vaultMasterChoice')>()
  const { vaultIdentityKey } = await import('./vaultMaster')
  return {
    ...real,
    probeVaultMasterUse: () => async (master: Parameters<typeof vaultIdentityKey>[0]) =>
      choice.unknown ? 'unknown' : choice.used.has(vaultIdentityKey(master)) ? 'used' : 'unused',
  }
})
vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))

import { rootKeyFromMnemonicBrc157, rootKeyFromMnemonicBrc75, restoreVaultFromMnemonic, restoreVaultFromRootKey } from './vault'
import { brc42VaultMaster, vaultIdentityKey } from './vaultMaster'

const WORDS_24 =
  'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title'
const WORDS_12 = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const password = 'CorrectHorse1'

beforeEach(() => {
  durable.clear()
  choice.used.clear()
  choice.unknown = false
})

describe('restore picks the derivation a backup was made with', () => {
  it('opens 24 unused words as BRC-157', async () => {
    const restored = await restoreVaultFromMnemonic({ mnemonic: WORDS_24, chain: 'main', password })
    expect(restored.master.derivation).toBe('brc-157')
    expect(restored.record.derivation).toBe('brc-157')
    expect(restored.record.identityKey).toBe(rootKeyFromMnemonicBrc157(WORDS_24).identityKey)
  })

  it('opens 12 unused words as BRC-75', async () => {
    const restored = await restoreVaultFromMnemonic({ mnemonic: WORDS_12, chain: 'main', password })
    expect(restored.master.derivation).toBe('brc-42')
    expect(restored.record.derivation).toBeUndefined()
    expect(restored.record.identityKey).toBe(rootKeyFromMnemonicBrc75(WORDS_12).identityKey)
  })

  it('opens 24 words as BRC-75 when that is the wallet with history', async () => {
    choice.used.add(rootKeyFromMnemonicBrc75(WORDS_24).identityKey)
    const restored = await restoreVaultFromMnemonic({ mnemonic: WORDS_24, chain: 'main', password })
    expect(restored.record.identityKey).toBe(rootKeyFromMnemonicBrc75(WORDS_24).identityKey)
  })

  it('stops instead of guessing when hosts cannot answer', async () => {
    choice.unknown = true
    await expect(restoreVaultFromMnemonic({ mnemonic: WORDS_24, chain: 'main', password })).rejects.toThrow(
      /could not check/,
    )
    expect(durable.size).toBe(0)
  })

  it('opens an emergency key as the BRC-42 root it was when that root has history', async () => {
    const key = '1ad0895dd317163f0e83499c30bc593dbcc54cad96a5f57b065ce9f700513250'
    choice.used.add(vaultIdentityKey(brc42VaultMaster(key)))
    const restored = await restoreVaultFromRootKey({ rootKeyHex: key, chain: 'main', password })
    expect(restored.master).toEqual(brc42VaultMaster(key))
  })
})
