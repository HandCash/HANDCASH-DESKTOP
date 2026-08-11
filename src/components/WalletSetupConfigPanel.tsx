import { useState } from 'react'
import {
  BACKUP_SERVICES_LIVE,
  DEFAULT_HISTORY_BACKUP_SETUP_URL,
  listWalletConfigOptions,
  type WalletConfigMode,
} from '../wallet/walletConfig'
import { applyWalletSetupSelection } from '../wallet/walletSetupApply'

type Props = {
  onDone: () => void
}

/**
 * Post-create only: choose Recommended / history-only / none.
 * Restore applies defaults in AuthScreen and skips this panel.
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
    setBusy(true)
    try {
      applyWalletSetupSelection(selected, historyUrl)
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
