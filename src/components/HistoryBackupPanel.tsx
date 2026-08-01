import { useMemo, useRef, useState, type FormEvent } from 'react'
import {
  downloadAndRestoreBrc39Backup,
  exportBrc39ToFile,
  importBrc39FromFile,
  uploadBrc39Backup,
} from '../wallet/historyBackup'
import {
  getHistoryBackupPrefs,
  resolveHistoryBackupBaseUrl,
  setHistoryBackupPrefs,
} from '../wallet/historyBackupPrefs'
import {
  canConfirmHistoryBackup,
  markHistoryBackupConfirmed,
  noteHistoryBackupExport,
} from '../wallet/backupStatus'
import { UNLOCK_PASSWORD_MIN_LENGTH } from '../wallet/passwordPolicy'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'

function formatWhen(ts: number | null): string {
  if (!ts) return 'Never'
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return 'Never'
  }
}

export function HistoryBackupPanel() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [prefs, setPrefs] = useState(() => getHistoryBackupPrefs())
  const [baseUrl, setBaseUrl] = useState(prefs.baseUrl)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<'file' | 'upload' | 'restore' | 'import' | null>(null)
  const [exportTick, setExportTick] = useState(0)
  const canConfirm = exportTick >= 0 && canConfirmHistoryBackup()

  const resolvedUrl = useMemo(
    () => resolveHistoryBackupBaseUrl({ ...prefs, baseUrl }),
    [prefs, baseUrl],
  )

  const saveUrl = () => {
    const next = setHistoryBackupPrefs({ baseUrl })
    setPrefs(next)
    playWalletSound('soft')
    toastSuccess(baseUrl.trim() ? 'Backup URL saved' : 'Backup URL cleared')
  }

  const confirmHistory = () => {
    if (!markHistoryBackupConfirmed()) {
      toastError('Export history first', 'Download or upload a .brc39 backup before confirming.')
      playWalletSound('deny')
      return
    }
    playWalletSound('success')
    toastSuccess('History backup saved')
  }

  const markExported = () => {
    noteHistoryBackupExport()
    setExportTick((n) => n + 1)
  }

  const runExportFile = async (e: FormEvent) => {
    e.preventDefault()
    setBusy('file')
    try {
      await exportBrc39ToFile(password)
      playWalletSound('success')
      toastSuccess('Downloaded wallet.brc39')
      markExported()
    } catch (err) {
      playWalletSound('error')
      toastError('Export failed', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const runUpload = async () => {
    setBusy('upload')
    try {
      setHistoryBackupPrefs({ baseUrl })
      const result = await uploadBrc39Backup(password)
      setPrefs(getHistoryBackupPrefs())
      playWalletSound('success')
      toastSuccess('Uploaded', formatWhen(result.exportedAt))
      markExported()
    } catch (err) {
      playWalletSound('error')
      toastError('Upload failed', err instanceof Error ? err.message : String(err))
      setPrefs(getHistoryBackupPrefs())
    } finally {
      setBusy(null)
    }
  }

  const runRestoreUrl = async () => {
    setBusy('restore')
    try {
      setHistoryBackupPrefs({ baseUrl })
      const result = await downloadAndRestoreBrc39Backup(password)
      playWalletSound('success')
      toastSuccess('Restored from URL', `${result.inserts + result.updates} changes`)
    } catch (err) {
      playWalletSound('error')
      toastError('Restore failed', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const runImportFile = async (file: File | null) => {
    if (!file) return
    setBusy('import')
    try {
      const result = await importBrc39FromFile(file, password)
      playWalletSound('success')
      toastSuccess('Imported', `${result.inserts + result.updates} changes`)
    } catch (err) {
      playWalletSound('error')
      toastError('Import failed', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="nav-section-body settings-scroll" data-aeon-scope="history-backup">
      <p className="settings-hint">
        <span className="spec-tag">BRC-39</span>
        <span className="settings-hint-after-tag">
          You will not be able to collect your funds without an up-to-date backup of your
          transactions. Keys alone are not enough. Download or upload before confirming.
        </span>
      </p>

      <div className="settings-form settings-form-compact">
        <div className="field">
          <label htmlFor="history-backup-url">URL (optional)</label>
          <input
            id="history-backup-url"
            type="url"
            placeholder="https://…"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="actions">
          <button type="button" className="btn btn-ghost" onClick={saveUrl}>
            Save URL
          </button>
        </div>
        {resolvedUrl ? (
          <p className="settings-row-desc">
            Last upload: {formatWhen(prefs.lastUploadedAt)}
            {prefs.lastError ? ` · ${prefs.lastError}` : ''}
          </p>
        ) : null}
      </div>

      <form className="settings-form settings-form-compact" onSubmit={(e) => void runExportFile(e)}>
        <div className="field">
          <label htmlFor="history-backup-password">Password</label>
          <input
            id="history-backup-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy !== null || password.length < UNLOCK_PASSWORD_MIN_LENGTH}
          >
            {busy === 'file' ? 'Exporting…' : 'Download .brc39'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy !== null || password.length < UNLOCK_PASSWORD_MIN_LENGTH}
            onClick={() => fileRef.current?.click()}
          >
            {busy === 'import' ? 'Importing…' : 'Import file'}
          </button>
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy !== null || password.length < UNLOCK_PASSWORD_MIN_LENGTH || !resolvedUrl}
            onClick={() => void runUpload()}
          >
            {busy === 'upload' ? 'Uploading…' : 'Upload to URL'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy !== null || password.length < UNLOCK_PASSWORD_MIN_LENGTH || !resolvedUrl}
            onClick={() => void runRestoreUrl()}
          >
            {busy === 'restore' ? 'Restoring…' : 'Restore from URL'}
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".brc39,application/vnd.brc39.wallet,application/octet-stream"
          hidden
          onChange={(e) => void runImportFile(e.target.files?.[0] ?? null)}
        />
      </form>

      <div className="actions" style={{ marginTop: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={confirmHistory}
          disabled={!canConfirm}
        >
          {canConfirm ? 'History backup saved' : 'Export first'}
        </button>
      </div>
    </div>
  )
}
