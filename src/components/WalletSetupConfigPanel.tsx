import { useState } from 'react'
import {
  BACKUP_SERVICES_LIVE,
  DEFAULT_HISTORY_BACKUP_SETUP_URL,
  HANDCASH_BACKUP_SERVICE_URL,
  HASTE_BACKUP_SERVICE_URL,
  listWalletConfigOptions,
  setWalletConfigPrefs,
  type WalletConfigMode,
} from '../wallet/walletConfig'
import { setHistoryBackupPrefs } from '../wallet/historyBackupPrefs'

type Props = {
  onDone: () => void
}

/**
 * Post-create / post-restore: choose Recommended (grayed) / history-only / none.
 */
export function WalletSetupConfigPanel({ onDone }: Props) {
  const options = listWalletConfigOptions()
  const [selected, setSelected] = useState<WalletConfigMode>(
    BACKUP_SERVICES_LIVE ? 'recommended' : 'history',
  )
  const [historyUrl, setHistoryUrl] = useState(DEFAULT_HISTORY_BACKUP_SETUP_URL)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const apply = async () => {
    setError(null)
    if (selected === 'recommended' && !BACKUP_SERVICES_LIVE) {
      setError('Recommended backup is not available yet.')
      return
    }
    setBusy(true)
    try {
      if (selected === 'recommended') {
        const urls = [HANDCASH_BACKUP_SERVICE_URL, HASTE_BACKUP_SERVICE_URL]
        setWalletConfigPrefs({
          mode: 'recommended',
          historyBaseUrl: historyUrl.trim(),
          backupServiceUrls: urls,
          configuredAt: Date.now(),
        })
        if (historyUrl.trim()) {
          setHistoryBackupPrefs({ baseUrl: historyUrl.trim(), lastError: null })
        }
        // Share deposit against live BRC-232 services is a follow-up once auth is real.
      } else if (selected === 'history') {
        const url = historyUrl.trim()
        if (!url) throw new Error('Enter a history backup URL')
        setHistoryBackupPrefs({ baseUrl: url, lastError: null })
        setWalletConfigPrefs({
          mode: 'history',
          historyBaseUrl: url,
          backupServiceUrls: [],
          configuredAt: Date.now(),
        })
      } else {
        setHistoryBackupPrefs({ baseUrl: '', lastError: null })
        setWalletConfigPrefs({
          mode: 'none',
          historyBaseUrl: '',
          backupServiceUrls: [],
          configuredAt: Date.now(),
        })
      }
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wallet-setup-config" data-aeon-scope="wallet-setup-config">
      <h2>Wallet configuration</h2>
      <p className="auth-lede">
        Choose how this install backs up recovery data. Signing always stays on this
        device.
      </p>

      <div className="wallet-setup-options" role="radiogroup" aria-label="Wallet configuration">
        {options.map((opt) => {
          const active = selected === opt.id
          return (
            <label
              key={opt.id}
              className={[
                'wallet-setup-option',
                active ? 'is-selected' : '',
                opt.disabled ? 'is-disabled' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <input
                type="radio"
                name="wallet-config"
                value={opt.id}
                checked={active}
                disabled={opt.disabled}
                onChange={() => {
                  if (!opt.disabled) setSelected(opt.id)
                }}
              />
              <span className="wallet-setup-option-body">
                <strong>{opt.title}</strong>
                <span>{opt.description}</span>
                {opt.disabled && opt.disabledReason ? (
                  <em className="wallet-setup-coming-soon">{opt.disabledReason}</em>
                ) : null}
                {opt.warning && active ? (
                  <span className="wallet-setup-warning" role="status">
                    {opt.warning}
                  </span>
                ) : null}
              </span>
            </label>
          )
        })}
      </div>

      {(selected === 'history' || (selected === 'recommended' && BACKUP_SERVICES_LIVE)) && (
        <div className="field">
          <label htmlFor="setup-history-url">History backup URL</label>
          <input
            id="setup-history-url"
            value={historyUrl}
            onChange={(e) => setHistoryUrl(e.target.value)}
            placeholder="http://127.0.0.1:8787"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="hint">
            Defaults to live <code>BRC-CLOUD</code> (
            {DEFAULT_HISTORY_BACKUP_SETUP_URL.replace(/^https?:\/\//, '')}).
          </p>
        </div>
      )}

      {error ? (
        <p className="wallet-sync-note is-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="auth-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void apply()}>
          {busy ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </div>
  )
}
