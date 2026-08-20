import type { DeviceBackupRoleStatus } from './deviceKeyBackup'
import { isSameIdentityPeer, type DeviceWallet } from './deviceWallets'

export type DeviceBackupGroups = {
  elsewhere: DeviceWallet[]
  here: DeviceWallet[]
  setup: DeviceWallet[]
  sameWallet: DeviceWallet[]
  attention: DeviceWallet[]
}

/**
 * Project directional backup records into storage locations a person can scan.
 * This is presentation grouping only; the device backup machine still owns the
 * legal one-way setup paths.
 */
export function groupDeviceBackups(
  peers: DeviceWallet[],
  localIdentityKey: string,
  roleFor: (deviceId: string) => DeviceBackupRoleStatus,
): DeviceBackupGroups {
  const groups: DeviceBackupGroups = {
    elsewhere: [],
    here: [],
    setup: [],
    sameWallet: [],
    attention: [],
  }
  for (const peer of peers) {
    const role = roleFor(peer.deviceId)
    if (localIdentityKey && isSameIdentityPeer(peer, localIdentityKey)) {
      groups.sameWallet.push(peer)
    } else if (
      role.direction === 'reciprocal' ||
      (role.recoveryCopyReceivedFromPeer && !role.protectsPeer)
    ) {
      groups.attention.push(peer)
    } else if (role.recoveryCopyIssuedToPeer) {
      groups.elsewhere.push(peer)
    } else if (role.protectsPeer) {
      groups.here.push(peer)
    } else {
      groups.setup.push(peer)
    }
  }
  return groups
}

/**
 * Section headings state the count out loud, so the screen reads as two plain
 * sentences: where this wallet is backed up, and what it stores for others.
 */
export function backedUpToTitle(count: number): string {
  if (count === 0) return 'This wallet is not backed up to another device'
  return `This wallet is backed up to ${count} ${count === 1 ? 'device' : 'devices'}`
}

export function storingTitle(count: number): string {
  if (count === 0) return 'This wallet is not storing any backups'
  return `This wallet is storing ${count} ${count === 1 ? 'backup' : 'backups'}`
}
