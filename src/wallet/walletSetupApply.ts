/**
 * Shared post-create / post-restore wallet setup prefs.
 * Keep AuthScreen and WalletSetupConfigPanel on the same apply path.
 */
import { setHistoryBackupPrefs } from './historyBackupPrefs'
import {
  BACKUP_SERVICES_LIVE,
  DEFAULT_HISTORY_BACKUP_SETUP_URL,
  HANDCASH_BACKUP_SERVICE_URL,
  HASTE_BACKUP_SERVICE_URL,
  setWalletConfigPrefs,
  type WalletConfigMode,
} from './walletConfig'

export function applyWalletSetupSelection(
  selected: WalletConfigMode,
  historyUrl: string,
): void {
  const url = historyUrl.trim()
  if (selected === 'recommended') {
    if (!BACKUP_SERVICES_LIVE) {
      throw new Error('Recommended backup is not available yet.')
    }
    setWalletConfigPrefs({
      mode: 'recommended',
      historyBaseUrl: url,
      backupServiceUrls: [HANDCASH_BACKUP_SERVICE_URL, HASTE_BACKUP_SERVICE_URL],
      configuredAt: Date.now(),
    })
    if (url) setHistoryBackupPrefs({ baseUrl: url, lastError: null })
    return
  }
  if (selected === 'history') {
    if (!url) throw new Error('Enter a history backup URL')
    setHistoryBackupPrefs({ baseUrl: url, lastError: null })
    setWalletConfigPrefs({
      mode: 'history',
      historyBaseUrl: url,
      backupServiceUrls: [],
      configuredAt: Date.now(),
    })
    return
  }
  setHistoryBackupPrefs({ baseUrl: '', lastError: null })
  setWalletConfigPrefs({
    mode: 'none',
    historyBaseUrl: '',
    backupServiceUrls: [],
    configuredAt: Date.now(),
  })
}

/** Fresh restore: pull BRC-39 from the default host without asking again. */
export function applyDefaultRestoreWalletSetup(): void {
  applyWalletSetupSelection(
    BACKUP_SERVICES_LIVE ? 'recommended' : 'history',
    DEFAULT_HISTORY_BACKUP_SETUP_URL,
  )
}
