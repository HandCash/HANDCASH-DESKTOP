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
import { hasDeviceKeyBackup } from '../../wallet/deviceKeyBackup'
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
  return { text: 'Independent providers · recommend two', tone: 'muted' }
}

export function keysStatus(): SettingRowStatus {
  if (isKeysBackupConfirmed()) return { text: 'Confirmed on this device', tone: 'ok' }
  return { text: 'Phrase or slices · offline', tone: 'warn' }
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
  return {
    text: 'Not synced · inactive',
    tone: 'muted',
  }
}

export function deviceHandoffStatus(): SettingRowStatus {
  const peers = listDeviceWallets().filter((w) => !w.isLocal)
  if (peers.length === 0) {
    return { text: 'Link identities · sealed spare keys', tone: 'muted' }
  }
  const withSpare = peers.filter((p) => hasDeviceKeyBackup(p.deviceId)).length
  if (withSpare === peers.length) {
    return {
      text: `${peers.length} linked · sealed spares ready`,
      tone: 'ok',
    }
  }
  if (withSpare > 0) {
    return {
      text: `${peers.length} linked · ${withSpare} with spare`,
      tone: 'warn',
    }
  }
  return {
    text: `${peers.length} linked · add sealed spares`,
    tone: 'warn',
  }
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
