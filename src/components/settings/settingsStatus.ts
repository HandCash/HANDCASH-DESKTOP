import {
  isHistoryBackupConfirmed,
  isKeysBackupConfirmed,
  isKeysBackupDeferred,
} from '../../wallet/backupStatus'
import { getDeviceLockMode, inferDeviceLockMode } from '../../wallet/deviceLockPrefs'
import {
  getHistoryBackupPrefs,
  resolveHistoryBackupBaseUrl,
} from '../../wallet/historyBackupPrefs'
import { handCashHistoryUrl } from '../../wallet/walletSetupApply'
import { listDeviceWallets } from '../../wallet/deviceWallets'
import { getDeviceBackupRoleStatus } from '../../wallet/deviceKeyBackup'
import type { SettingId } from '../../wallet/navStore'

export type SettingRowStatus = {
  text: string
  tone: 'ok' | 'warn' | 'muted'
}

export function keysStatus(): SettingRowStatus {
  if (isKeysBackupConfirmed()) return { text: 'Confirmed on this device', tone: 'ok' }
  if (isKeysBackupDeferred()) return { text: 'Do this later — still needed', tone: 'warn' }
  return { text: 'Not backed up', tone: 'warn' }
}

export function unlockStatus(): SettingRowStatus {
  const mode = getDeviceLockMode() ?? inferDeviceLockMode()
  switch (mode) {
    case 'none':
      return { text: 'No lock on this device', tone: 'muted' }
    case 'password':
      return { text: 'Password', tone: 'ok' }
    case 'device':
      return { text: 'Touch ID', tone: 'ok' }
    case 'both':
      return { text: 'Password + Touch ID', tone: 'ok' }
    default:
      return { text: 'Not set', tone: 'warn' }
  }
}

export function historyStatus(): SettingRowStatus {
  const prefs = getHistoryBackupPrefs()
  const url = resolveHistoryBackupBaseUrl(prefs)
  if (isHistoryBackupConfirmed() && url) {
    return { text: 'Confirmed · cloud ready', tone: 'ok' }
  }
  if (url) {
    const handCash = url.replace(/\/+$/, '') === handCashHistoryUrl()
    return {
      text: handCash ? 'HandCash · cloud ready' : `Custom host · ${url.replace(/^https?:\/\//, '').slice(0, 22)}`,
      tone: 'muted',
    }
  }
  return { text: 'Not backed up', tone: 'warn' }
}

export function deviceHandoffStatus(): SettingRowStatus {
  const peers = listDeviceWallets().filter((w) => !w.isLocal)
  if (peers.length === 0) {
    return { text: 'Not set up', tone: 'muted' }
  }
  const label = peers.length === 1 ? '1 device' : `${peers.length} devices`
  const roles = peers.map((role) => getDeviceBackupRoleStatus(role.deviceId))
  if (roles.some((role) => role.direction === 'reciprocal')) {
    return { text: 'Both sides hold a copy', tone: 'warn' }
  }
  const elsewhere = roles.filter((role) => role.recoveryCopyIssuedToPeer).length
  const here = roles.filter((role) => role.protectsPeer).length
  const configured = elsewhere + here
  if (configured === 0) return { text: `${label} · no copy yet`, tone: 'muted' }

  const parts: string[] = []
  if (elsewhere > 0) parts.push(`Backed up to ${elsewhere}`)
  if (here > 0) parts.push(parts.length ? `storing ${here}` : `Storing ${here}`)
  return {
    text: parts.join(' · '),
    tone: configured === peers.length ? 'ok' : 'muted',
  }
}

export function statusForSetting(id: SettingId): SettingRowStatus | null {
  switch (id) {
    case 'backup':
      return keysStatus()
    case 'history-backup':
      return historyStatus()
    case 'device-handoff':
      return deviceHandoffStatus()
    case 'change-password':
      return unlockStatus()
    default:
      return null
  }
}
