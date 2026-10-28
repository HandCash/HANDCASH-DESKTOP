import type { SettingId } from '../../wallet/navStore'

const SECURITY_LABELS: Partial<Record<SettingId, string>> = {
  backup: 'Recovery backup',
  'history-backup': 'History',
  'device-handoff': 'Device backup',
  'signin-email': 'Sign-in email',
  import: 'Import',
  'change-password': 'Unlock',
  'wipe-wallet': 'Wipe wallet',
}

/** Titlebar / breadcrumb label for a Settings child. */
export function settingLabel(id: SettingId): string {
  if (id === 'about-handcash') return 'HandCash'
  if (id === 'statecharts') return 'Statecharts'
  if (id === 'logs') return 'Session logs'
  if (id === 'wallet-health') return 'Wallet health'
  if (id === 'recover-tx') return 'Recover from transaction'
  if (id === 'labs') return 'Labs'
  if (id === 'chart-apps') return 'Apps'
  if (id === 'backup' || id === 'backup-phrase' || id === 'split-backup') return 'Recovery backup'
  if (id === 'device-handoff') return 'Device backup'
  if (id === 'handcash-recovery') return 'HandCash Recovery'
  if (id === 'change-password') return 'Unlock'
  return SECURITY_LABELS[id] ?? 'Setting'
}
