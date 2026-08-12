import { useEffect, useState } from 'react'
import {
  getHistoryBackupPrefs,
  setHistoryBackupPrefs,
} from '../../wallet/historyBackupPrefs'
import { getWalletConfigPrefs } from '../../wallet/walletConfig'
import {
  HANDCASH_HISTORY_HOST_LABEL,
  ensureHandCashServiceDefaults,
  handCashHistoryUrl,
} from '../../wallet/walletSetupApply'
import { playWalletSound } from '../../wallet/soundService'
import { toastSuccess } from '../../wallet/toast'

type Props = {
  id?: string
  label?: string
  /** Show Save / Use HandCash actions (default true). */
  showActions?: boolean
  onSaved?: (baseUrl: string) => void
}

function isHandCashUrl(url: string): boolean {
  const a = url.trim().replace(/\/+$/, '')
  const b = handCashHistoryUrl()
  return Boolean(a) && a === b
}

/**
 * History backup host. HandCash is the default; a custom URL is opt-in.
 * Does not persist HandCash when the user chose "no backup" at setup.
 */
export function HistoryBackupUrlField({
  id = 'history-backup-url',
  label = 'History host',
  showActions = true,
  onSaved,
}: Props) {
  const [prefs, setPrefs] = useState(() => getHistoryBackupPrefs())
  const [customHost, setCustomHost] = useState(() => {
    const url = getHistoryBackupPrefs().baseUrl
    return Boolean(url.trim()) && !isHandCashUrl(url)
  })
  const [draft, setDraft] = useState(() => getHistoryBackupPrefs().baseUrl || handCashHistoryUrl())
  const optedOut = getWalletConfigPrefs().mode === 'none'
  const usingHandCash = !optedOut && !customHost && isHandCashUrl(prefs.baseUrl || handCashHistoryUrl())

  useEffect(() => {
    if (!optedOut) {
      try {
        ensureHandCashServiceDefaults()
      } catch {
        /* ignore */
      }
    }
    const next = getHistoryBackupPrefs()
    setPrefs(next)
    const url = next.baseUrl.trim()
    if (url && !isHandCashUrl(url)) {
      setCustomHost(true)
      setDraft(url)
    } else {
      setDraft(url || handCashHistoryUrl())
    }
  }, [optedOut])

  const save = (url: string) => {
    const next = setHistoryBackupPrefs({ baseUrl: url })
    setPrefs(next)
    setDraft(next.baseUrl || handCashHistoryUrl())
    playWalletSound('soft')
    toastSuccess(
      next.baseUrl
        ? isHandCashUrl(next.baseUrl)
          ? 'Using HandCash history'
          : 'Custom history host saved'
        : 'History host cleared',
    )
    onSaved?.(next.baseUrl)
  }

  return (
    <div className="settings-form settings-form-compact" data-aeon-part="history-url-field">
      {!customHost && !optedOut ? (
        <p className="settings-row-desc" data-aeon-part="history-url-hint">
          History host: <strong>{HANDCASH_HISTORY_HOST_LABEL}</strong>
        </p>
      ) : null}

      {optedOut && !customHost ? (
        <p className="settings-row-desc" data-aeon-part="history-url-hint">
          No backup host — you chose not to use HandCash during setup.
        </p>
      ) : null}

      <label className="wallet-setup-option" style={{ marginTop: 8 }}>
        <input
          type="checkbox"
          checked={customHost}
          onChange={(e) => {
            const on = e.target.checked
            setCustomHost(on)
            if (!on && !optedOut) save(handCashHistoryUrl())
          }}
        />
        <span className="wallet-setup-option-body">
          <strong>Use a custom history host</strong>
          <span>Only if you run your own BRC-39 backup server.</span>
        </span>
      </label>

      {customHost ? (
        <div className="field">
          <label htmlFor={id}>{label}</label>
          <input
            id={id}
            type="url"
            placeholder={handCashHistoryUrl()}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      ) : null}

      {showActions && customHost ? (
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => save(draft)}>
            Save URL
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setCustomHost(false)
              save(handCashHistoryUrl())
            }}
          >
            Use HandCash
          </button>
        </div>
      ) : null}

      {usingHandCash ? (
        <p className="settings-row-desc">HandCash is used automatically unless you choose a custom host.</p>
      ) : null}
    </div>
  )
}
