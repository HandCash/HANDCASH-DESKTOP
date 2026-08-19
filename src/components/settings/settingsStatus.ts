import {
  getEnrollmentForOperator,
  getTrustholderEnrollments,
} from '../../wallet/trustholderBackup'
import {
  isHistoryBackupConfirmed,
  isKeysBackupConfirmed,
} from '../../wallet/backupStatus'
import {
  getHistoryBackupPrefs,
  resolveHistoryBackupBaseUrl,
} from '../../wallet/historyBackupPrefs'
import { handCashHistoryUrl } from '../../wallet/walletSetupApply'
import { listDeviceWallets } from '../../wallet/deviceWallets'
import { getDeviceBackupRoleStatus } from '../../wallet/deviceKeyBackup'
import { TRUSTHOLDERS_ENABLED } from '../../wallet/walletConfig'
import type { SettingId } from '../../wallet/navStore'

export type SettingRowStatus = {
  text: string
  tone: 'ok' | 'warn' | 'muted'
}

export function trustholderStatus(): SettingRowStatus {
  const { enrollments } = getTrustholderEnrollments()
  const hc = getEnrollmentForOperator('handcash')
  const haste = getEnrollmentForOperator('haste')
  if (hc && haste) {
    return { text: 'HandCash & Haste enrolled', tone: 'ok' }
  }
  if (enrollments.length === 1) {
    const label = enrollments[0]!.operator === 'haste' ? 'Haste' : 'HandCash'
    return { text: `${label} enrolled · add another anytime`, tone: 'ok' }
  }
  return { text: 'Recommend two providers', tone: 'muted' }
}

export function keysStatus(): SettingRowStatus {
  if (isKeysBackupConfirmed()) return { text: 'Confirmed on this device', tone: 'ok' }
  return { text: 'Not backed up', tone: 'warn' }
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
    return { text: 'Both directions — unsafe', tone: 'warn' }
  }
  const withCopy = roles.filter((role) => role.direction !== 'none').length
  if (withCopy === 0) return { text: `${label} · no copy yet`, tone: 'muted' }
  if (withCopy === peers.length) return { text: `${label} · one-way`, tone: 'ok' }
  return { text: `${label} · ${withCopy} protected`, tone: 'muted' }
}

export function statusForSetting(id: SettingId): SettingRowStatus | null {
  switch (id) {
    case 'backup':
      return keysStatus()
    case 'trustholder-backup':
      return TRUSTHOLDERS_ENABLED ? trustholderStatus() : keysStatus()
    case 'history-backup':
      return historyStatus()
    case 'device-handoff':
      return deviceHandoffStatus()
    default:
      return null
  }
}
