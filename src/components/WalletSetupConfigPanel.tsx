import { useState } from 'react'
import {
  listWalletConfigOptions,
  type WalletConfigMode,
} from '../wallet/walletConfig'
import {
  applyWalletSetupSelection,
  HANDCASH_HISTORY_HOST_LABEL,
  handCashHistoryUrl,
} from '../wallet/walletSetupApply'

type Props = {
  onDone: () => void
}

/**
 * Post-create only: choose history backup or local-only.
 * Restore applies HandCash defaults in AuthScreen and skips this panel.
 * Custom history host is opt-in — otherwise everything is HandCash.
 */
export function WalletSetupConfigPanel({ onDone }: Props) {
  const options = listWalletConfigOptions()
  const [selected, setSelected] = useState<WalletConfigMode>('history')
  const [customHost, setCustomHost] = useState(false)
  const [historyUrl, setHistoryUrl] = useState(handCashHistoryUrl())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const apply = async () => {
    setError(null)
    setBusy(true)
    try {
      const url =
        selected === 'none'
          ? ''
          : customHost
            ? historyUrl.trim()
            : handCashHistoryUrl()
      applyWalletSetupSelection(selected, url)
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
        HandCash cloud is used for history across devices unless you choose otherwise.
        Signing and key backup stay on this device (phrase or slices).
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

      {selected !== 'none' && !customHost ? (
        <p className="hint">
          History host: <strong>{HANDCASH_HISTORY_HOST_LABEL}</strong>
        </p>
      ) : null}

      {selected !== 'none' ? (
        <label className="wallet-setup-option" style={{ marginTop: 8 }}>
          <input
            type="checkbox"
            checked={customHost}
            onChange={(e) => setCustomHost(e.target.checked)}
          />
          <span className="wallet-setup-option-body">
            <strong>Use a custom history host</strong>
            <span>Only if you run your own BRC-39 backup server.</span>
          </span>
        </label>
      ) : null}

      {customHost && selected !== 'none' ? (
        <div className="field">
          <label htmlFor="setup-history-url">History backup URL</label>
          <input
            id="setup-history-url"
            value={historyUrl}
            onChange={(e) => setHistoryUrl(e.target.value)}
            placeholder={handCashHistoryUrl()}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      ) : null}

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
