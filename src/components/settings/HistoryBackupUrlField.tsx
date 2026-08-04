import { useEffect, useState } from 'react'
import {
  displayHistoryBackupBaseUrl,
  getHistoryBackupPrefs,
  setHistoryBackupPrefs,
  SUGGESTED_HISTORY_BACKUP_BASE_URL,
} from '../../wallet/historyBackupPrefs'
import { playWalletSound } from '../../wallet/soundService'
import { toastSuccess } from '../../wallet/toast'

type Props = {
  id?: string
  label?: string
  /** Show Save / Use suggested actions (default true). */
  showActions?: boolean
  onSaved?: (baseUrl: string) => void
}

/**
 * Single source of truth for the History backup URL field.
 * Always surfaces the suggested BRC-CLOUD default when nothing is saved.
 */
export function HistoryBackupUrlField({
  id = 'history-backup-url',
  label = 'Backup URL',
  showActions = true,
  onSaved,
}: Props) {
  const [prefs, setPrefs] = useState(() => getHistoryBackupPrefs())
  const [draft, setDraft] = useState(() => displayHistoryBackupBaseUrl(prefs))
  const suggested = SUGGESTED_HISTORY_BACKUP_BASE_URL
  const usingSuggested =
    !prefs.baseUrl.trim() ||
    prefs.baseUrl.replace(/\/+$/, '') === suggested.replace(/\/+$/, '')

  useEffect(() => {
    const next = getHistoryBackupPrefs()
    setPrefs(next)
    setDraft(displayHistoryBackupBaseUrl(next))
  }, [])

  const save = (url: string) => {
    const next = setHistoryBackupPrefs({ baseUrl: url })
    setPrefs(next)
    setDraft(displayHistoryBackupBaseUrl(next))
    playWalletSound('soft')
    toastSuccess(url.trim() ? 'Backup URL saved' : 'Backup URL cleared')
    onSaved?.(next.baseUrl)
  }

  return (
    <div className="settings-form settings-form-compact" data-aeon-part="history-url-field">
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          type="url"
          placeholder={suggested}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <p className="settings-row-desc" data-aeon-part="history-url-hint">
        {usingSuggested
          ? `Suggested default · ${suggested.replace(/^https?:\/\//, '')}`
          : `Custom · suggested is ${suggested.replace(/^https?:\/\//, '')}`}
      </p>
      {showActions ? (
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => save(draft)}>
            Save URL
          </button>
          {!usingSuggested || draft.trim() !== suggested ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setDraft(suggested)
                save(suggested)
              }}
            >
              Use suggested
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
