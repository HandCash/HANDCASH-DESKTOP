/**
 * Shared post-create / post-restore wallet setup prefs.
 * Keep AuthScreen and WalletSetupConfigPanel on the same apply path.
 *
 * HandCash cloud (BRC-CLOUD) is the default for history unless the user
 * explicitly chooses "no backup" or a custom history host.
 */
import { getHistoryBackupPrefs, setHistoryBackupPrefs } from './historyBackupPrefs'
import {
  DEFAULT_HISTORY_BACKUP_SETUP_URL,
  getWalletConfigPrefs,
  setWalletConfigPrefs,
  type WalletConfigMode,
} from './walletConfig'

export const HANDCASH_HISTORY_HOST_LABEL = 'HandCash'

export function handCashHistoryUrl(): string {
  return DEFAULT_HISTORY_BACKUP_SETUP_URL.replace(/\/+$/, '')
}

export function applyWalletSetupSelection(
  selected: WalletConfigMode,
  historyUrl: string,
): void {
  const url = historyUrl.trim() || (selected === 'none' ? '' : handCashHistoryUrl())
  if (selected === 'history') {
    if (!url) throw new Error('Enter a history backup URL')
    setHistoryBackupPrefs({ baseUrl: url, lastError: null })
    setWalletConfigPrefs({
      mode: 'history',
      historyBaseUrl: url,
      configuredAt: Date.now(),
    })
    return
  }
  setHistoryBackupPrefs({ baseUrl: '', lastError: null })
  setWalletConfigPrefs({
    mode: 'none',
    historyBaseUrl: '',
    configuredAt: Date.now(),
  })
}

/** Fresh restore: pull BRC-39 from HandCash without asking again. */
export function applyDefaultRestoreWalletSetup(): void {
  applyWalletSetupSelection('history', handCashHistoryUrl())
}

/**
 * Fill HandCash history when the user never opted out.
 * No-op for explicit "no backup". Heals older installs that left URLs blank.
 */
export function ensureHandCashServiceDefaults(): void {
  const cfg = getWalletConfigPrefs()
  if (cfg.mode === 'none') return

  if (!cfg.mode) {
    try {
      applyDefaultRestoreWalletSetup()
    } catch (err) {
      console.warn('[setup] HandCash defaults failed', err)
    }
    return
  }

  const historyUrl = (cfg.historyBaseUrl.trim() || handCashHistoryUrl()).replace(/\/+$/, '')
  if (!getHistoryBackupPrefs().baseUrl.trim() && historyUrl) {
    setHistoryBackupPrefs({ baseUrl: historyUrl, lastError: null })
  }

  if (!cfg.historyBaseUrl.trim() && historyUrl) {
    setWalletConfigPrefs({ historyBaseUrl: historyUrl })
  }
}
