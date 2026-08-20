import { describe, expect, it } from 'vitest'
import type { DeviceBackupRoleStatus } from '../wallet/deviceKeyBackup'
import {
  backedUpToTitle,
  groupDeviceBackups,
  storingTitle,
} from '../wallet/deviceBackupGroups'
import type { DeviceWallet } from '../wallet/deviceWallets'

const localIdentityKey = `02${'11'.repeat(32)}`

function peer(
  deviceId: string,
  identityKey = `03${deviceId.padEnd(64, '0').slice(0, 64)}`,
): DeviceWallet {
  return {
    deviceId,
    label: deviceId,
    platform: 'test',
    peerBaseUrl: null,
    isLocal: false,
    identityKey,
    address: null,
    lastSeenAt: null,
    online: false,
    linkedAt: null,
    linkMode: identityKey === localIdentityKey ? 'linked' : 'backup-only',
  }
}

function role(
  direction: DeviceBackupRoleStatus['direction'],
): DeviceBackupRoleStatus {
  return {
    direction,
    protectsPeer:
      direction === 'peer-wallet-to-this-device' || direction === 'reciprocal',
    recoveryCopyReceivedFromPeer:
      direction === 'peer-wallet-to-this-device' || direction === 'reciprocal',
    recoveryCopyIssuedToPeer:
      direction === 'this-wallet-to-peer' || direction === 'reciprocal',
  }
}

describe('groupDeviceBackups', () => {
  it('separates where this wallet is backed up from backups stored here', () => {
    const peers = [
      peer('elsewhere'),
      peer('here'),
      peer('setup'),
      peer('same', localIdentityKey),
      peer('unsafe'),
    ]
    const roles: Record<string, DeviceBackupRoleStatus> = {
      elsewhere: role('this-wallet-to-peer'),
      here: role('peer-wallet-to-this-device'),
      setup: role('none'),
      same: role('none'),
      unsafe: role('reciprocal'),
    }

    const groups = groupDeviceBackups(
      peers,
      localIdentityKey,
      (deviceId) => roles[deviceId]!,
    )

    expect(groups.elsewhere.map((item) => item.deviceId)).toEqual(['elsewhere'])
    expect(groups.here.map((item) => item.deviceId)).toEqual(['here'])
    expect(groups.setup.map((item) => item.deviceId)).toEqual(['setup'])
    expect(groups.sameWallet.map((item) => item.deviceId)).toEqual(['same'])
    expect(groups.attention.map((item) => item.deviceId)).toEqual(['unsafe'])
  })

  it('uses actual stored ciphertext, not a received-copy tombstone, for stored here', () => {
    const missing = role('peer-wallet-to-this-device')
    missing.protectsPeer = false

    const groups = groupDeviceBackups(
      [peer('missing')],
      localIdentityKey,
      () => missing,
    )

    expect(groups.here).toEqual([])
    expect(groups.setup).toEqual([])
    expect(groups.attention.map((item) => item.deviceId)).toEqual(['missing'])
  })
})

describe('device backup section titles', () => {
  it('names the direction and the count, and never says link', () => {
    expect(backedUpToTitle(1)).toBe('This wallet is backed up to 1 device')
    expect(backedUpToTitle(2)).toBe('This wallet is backed up to 2 devices')
    expect(storingTitle(1)).toBe('This wallet is storing 1 backup')
    expect(storingTitle(3)).toBe('This wallet is storing 3 backups')
    for (const title of [backedUpToTitle(0), storingTitle(0)]) {
      expect(title).not.toMatch(/link/i)
      expect(title).toMatch(/^This wallet is not /)
    }
  })
})
