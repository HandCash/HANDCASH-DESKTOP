import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PrivateKey } from '@bsv/sdk'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

const alice = PrivateKey.fromRandom()
const bob = PrivateKey.fromRandom()

const unlockVault = vi.fn()
const getActiveWallet = vi.fn()

vi.mock('./vault', () => ({
  unlockVault: (...args: unknown[]) => unlockVault(...args),
}))

vi.mock('./session', () => ({
  getActiveWallet: () => getActiveWallet(),
}))

function asAlice() {
  store.set('handcash.brc100.deviceId.v1', 'alice-device')
  getActiveWallet.mockReturnValue({
    rootKeyHex: alice.toHex(),
    identityKey: alice.toPublicKey().toString(),
    address: alice.toAddress(),
  })
  unlockVault.mockImplementation(async (password: string) => {
    if (password !== 'password12') throw new Error('Incorrect password')
    return {
      rootKeyHex: alice.toHex(),
      mnemonic:
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      record: { identityKey: alice.toPublicKey().toString() },
    }
  })
}

function asBob() {
  store.set('handcash.brc100.deviceId.v1', 'bob-device')
  getActiveWallet.mockReturnValue({
    rootKeyHex: bob.toHex(),
    identityKey: bob.toPublicKey().toString(),
    address: bob.toAddress(),
  })
  unlockVault.mockImplementation(async (password: string) => {
    if (password !== 'password12') throw new Error('Incorrect password')
    return {
      rootKeyHex: bob.toHex(),
      mnemonic: null,
      record: { identityKey: bob.toPublicKey().toString() },
    }
  })
}

describe('deviceKeyBackup', () => {
  beforeEach(() => {
    store.clear()
    asAlice()
  })

  it(
    'seals to peer pubkey, imports on peer, opens only with peer key',
    async () => {
      const {
        createSealedBackupForPeer,
        deviceKeyBackupToQrText,
        importSealedDeviceKeyBackup,
        openStoredDeviceKeyBackup,
        parseDeviceKeyBackupPackage,
      } = await import('./deviceKeyBackup')

      const pkg = await createSealedBackupForPeer({
        password: 'password12',
        peerIdentityKey: bob.toPublicKey().toString(),
        peerDeviceId: 'bob-device',
        label: 'This Mac',
      })
      expect(pkg.forIdentityKey).toBe(bob.toPublicKey().toString())
      expect(pkg.fromIdentityKey).toBe(alice.toPublicKey().toString())

      const { getDeviceBackupRoleStatus } = await import('./deviceKeyBackup')
      expect(getDeviceBackupRoleStatus('bob-device')).toEqual({
        protectsPeer: false,
        recoveryCopyReceivedFromPeer: false,
        recoveryCopyIssuedToPeer: true,
        direction: 'this-wallet-to-peer',
      })

      const text = deviceKeyBackupToQrText(pkg)
      expect(parseDeviceKeyBackupPackage(text).fromDeviceId).toBe('alice-device')

      asBob()
      const stored = importSealedDeviceKeyBackup(text)
      expect(stored.fromLabel).toBe('This Mac')
      expect(getDeviceBackupRoleStatus('alice-device')).toEqual({
        protectsPeer: true,
        recoveryCopyReceivedFromPeer: true,
        recoveryCopyIssuedToPeer: false,
        direction: 'peer-wallet-to-this-device',
      })

      const opened = await openStoredDeviceKeyBackup({
        peerDeviceId: 'alice-device',
        password: 'password12',
      })
      expect(opened.identityKey).toBe(alice.toPublicKey().toString())
      expect(opened.mnemonic).toContain('abandon')
      expect(opened.rootKeyHex).toBe(alice.toHex())
    },
    15_000,
  )

  it('refuses import sealed for a different identity', async () => {
    const { createSealedBackupForPeer, importSealedDeviceKeyBackup } = await import(
      './deviceKeyBackup'
    )
    const pkg = await createSealedBackupForPeer({
      password: 'password12',
      peerIdentityKey: bob.toPublicKey().toString(),
      peerDeviceId: 'bob-device',
    })
    expect(() => importSealedDeviceKeyBackup(JSON.stringify(pkg))).toThrow(/different identity/i)
  })

  it('refuses a reciprocal recovery copy', async () => {
    const {
      createSealedBackupForPeer,
      clearSpareExchangeForPeer,
      deviceKeyBackupToQrText,
      importSealedDeviceKeyBackup,
    } = await import('./deviceKeyBackup')
    const aliceForBob = await createSealedBackupForPeer({
      password: 'password12',
      peerIdentityKey: bob.toPublicKey().toString(),
      peerDeviceId: 'bob-device',
    })

    asBob()
    importSealedDeviceKeyBackup(deviceKeyBackupToQrText(aliceForBob))
    clearSpareExchangeForPeer('alice-device')

    await expect(
      createSealedBackupForPeer({
        password: 'password12',
        peerIdentityKey: alice.toPublicKey().toString(),
        peerDeviceId: 'alice-device',
      }),
    ).rejects.toThrow(/reciprocal device backups are refused/i)
  })
})
