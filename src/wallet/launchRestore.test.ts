import { PrivateKey } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const durable = new Map<string, string>()
const disk = vi.hoisted(() => ({ refuse: false }))

vi.mock('./durableStorage.js', () => ({
  durableGetItem: (key: string) => durable.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    if (disk.refuse) return false
    durable.set(key, value)
    return true
  },
}))
vi.mock('./vaultMasterChoice', async (importOriginal) => {
  const real = await importOriginal<typeof import('./vaultMasterChoice')>()
  return { ...real, probeVaultMasterUse: () => async () => 'unused' as const }
})
vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))

import { openVaultTransfer, sealVaultTransfer, type VaultTransfer } from './deviceTransfer'
import { recoveryPhraseProblem } from './recoveryPhraseCheck'
import { classifyUnlockFailure } from './unlockFailure'
import { createVault, restoreVaultFromMaster, restoreVaultFromMnemonic, unlockVault } from './vault'
import { accountRootKeyHex, type VaultMaster } from './vaultMaster'

const password = 'CorrectHorse1'
const accountKeys = (master: VaultMaster) => [0, 1, 2].map((n) => accountRootKeyHex(master, n))

/** A fresh install: nothing stored on this device. */
function freshInstall(): void {
  durable.clear()
  disk.refuse = false
}

beforeEach(freshInstall)

describe('restoring a wallet from its recovery phrase on a fresh install', () => {
  it('gets the same identity and account keys the original created', async () => {
    const original = await createVault({ chain: 'main', password })
    const phrase = original.mnemonic!
    freshInstall()

    const restored = await restoreVaultFromMnemonic({ mnemonic: phrase, chain: 'main', password })
    expect(restored.record.identityKey).toBe(original.record.identityKey)
    expect(accountKeys(restored.master)).toEqual(accountKeys(original.master))
  })

  it('takes the phrase with stray capitals and spacing', async () => {
    const original = await createVault({ chain: 'main', password })
    freshInstall()
    const messy = `  ${original.mnemonic!.toUpperCase().split(' ').join('   ')}\n`
    const restored = await restoreVaultFromMnemonic({ mnemonic: messy, chain: 'main', password })
    expect(restored.record.identityKey).toBe(original.record.identityKey)
  })

  it('survives a restart right after the restore: the saved vault unlocks to the same keys', async () => {
    const original = await createVault({ chain: 'main', password })
    freshInstall()
    await restoreVaultFromMnemonic({ mnemonic: original.mnemonic!, chain: 'main', password })

    vi.resetModules()
    const relaunched = await import('./vault')
    const unlocked = await relaunched.unlockVault(password)
    expect(unlocked.record.identityKey).toBe(original.record.identityKey)
    expect(accountKeys(unlocked.master)).toEqual(accountKeys(original.master))
  })

  it('names a misspelt word and writes nothing', async () => {
    const original = await createVault({ chain: 'main', password })
    freshInstall()
    const words = original.mnemonic!.split(' ')
    words[3] = `${words[3]}x`
    const attempt = restoreVaultFromMnemonic({ mnemonic: words.join(' '), chain: 'main', password })
    await expect(attempt).rejects.toThrow(/word 4/)
    expect(durable.size).toBe(0)
  })

  it('says when valid words are in the wrong order, and lets the message through unchanged', async () => {
    const original = await createVault({ chain: 'main', password })
    freshInstall()
    const words = original.mnemonic!.split(' ')
    const swapped = [words[1], words[0], ...words.slice(2)].join(' ')
    const problem = recoveryPhraseProblem(swapped)
    // A swap keeps the checksum valid once in 16; the restore then opens another wallet.
    if (problem) {
      await expect(restoreVaultFromMnemonic({ mnemonic: swapped, chain: 'main', password })).rejects.toThrow(
        /wrong or out of order/,
      )
      expect(classifyUnlockFailure(new Error(problem)).message).toBe(problem)
    }
    expect(recoveryPhraseProblem(words.slice(0, 11).join(' '))).toMatch(/has 11/)
    expect(recoveryPhraseProblem('   ')).toBe('Enter your recovery phrase.')
    expect(recoveryPhraseProblem(original.mnemonic!)).toBeNull()
  })

  it('fails closed when the device will not save the vault', async () => {
    const original = await createVault({ chain: 'main', password })
    freshInstall()
    disk.refuse = true
    await expect(
      restoreVaultFromMnemonic({ mnemonic: original.mnemonic!, chain: 'main', password }),
    ).rejects.toThrow(/Failed to persist/)
    expect(durable.size).toBe(0)
  })
})

describe('signing in with a vault an approved device sent', () => {
  it('installs the same identity and account keys as the approving device', async () => {
    const original = await createVault({ chain: 'main', password })
    const loginKey = PrivateKey.fromRandom()
    const transfer: VaultTransfer = {
      v: 1,
      kind: 'handcash-brc250-vault',
      master: original.master,
      enrollment: null,
      accounts: { version: 1 },
      sentAt: Date.now(),
    }
    const sealed = sealVaultTransfer(transfer, PrivateKey.fromRandom(), loginKey.toPublicKey().toString())
    freshInstall()

    const opened = openVaultTransfer(sealed, loginKey)
    const installed = await restoreVaultFromMaster({ master: opened.master, chain: 'main', password })
    expect(installed.record.identityKey).toBe(original.record.identityKey)
    expect(accountKeys(installed.master)).toEqual(accountKeys(original.master))
    expect(installed.mnemonic).toBeNull()

    const unlocked = await unlockVault(password)
    expect(unlocked.record.identityKey).toBe(original.record.identityKey)
  })

  it('cannot be opened by any key but the new device’s one-time key', async () => {
    const original = await createVault({ chain: 'main', password })
    const transfer: VaultTransfer = {
      v: 1, kind: 'handcash-brc250-vault', master: original.master, enrollment: null, accounts: { version: 1 }, sentAt: 1,
    }
    const sealed = sealVaultTransfer(transfer, PrivateKey.fromRandom(), PrivateKey.fromRandom().toPublicKey().toString())
    expect(() => openVaultTransfer(sealed, PrivateKey.fromRandom())).toThrow()
  })
})
