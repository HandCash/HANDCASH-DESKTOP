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
import { playWalletSound } from '../wallet/soundService'

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
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  const resolvedUrl = useMemo(
    () => resolveHistoryBackupBaseUrl({ ...prefs, baseUrl }),
    [prefs, baseUrl],
  )

  const saveUrl = () => {
    const next = setHistoryBackupPrefs({ baseUrl })
    setPrefs(next)
    playWalletSound('soft')
    setOk(baseUrl.trim() ? 'Backup URL saved' : 'Backup URL cleared')
  }

  const runExportFile = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setOk(null)
    setBusy('file')
    try {
      await exportBrc39ToFile(password)
      playWalletSound('success')
      setOk('Downloaded wallet.brc39 (BRC-39 · password-encrypted)')
    } catch (err) {
      playWalletSound('error')
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const runUpload = async () => {
    setError(null)
    setOk(null)
    setBusy('upload')
    try {
      setHistoryBackupPrefs({ baseUrl })
      const result = await uploadBrc39Backup(password)
      setPrefs(getHistoryBackupPrefs())
      playWalletSound('success')
      setOk(`Uploaded BRC-39 · ${formatWhen(result.exportedAt)}`)
    } catch (err) {
      playWalletSound('error')
      setError(err instanceof Error ? err.message : String(err))
      setPrefs(getHistoryBackupPrefs())
    } finally {
      setBusy(null)
    }
  }

  const runRestoreUrl = async () => {
    setError(null)
    setOk(null)
    setBusy('restore')
    try {
      setHistoryBackupPrefs({ baseUrl })
      const result = await downloadAndRestoreBrc39Backup(password)
      playWalletSound('success')
      setOk(
        `Merged from URL · +${result.inserts} inserts · ${result.updates} updates`,
      )
    } catch (err) {
      playWalletSound('error')
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const runImportFile = async (file: File | null) => {
    if (!file) return
    setError(null)
    setOk(null)
    setBusy('import')
    try {
      const result = await importBrc39FromFile(file, password)
      playWalletSound('success')
      setOk(
        `Merged from file · +${result.inserts} inserts · ${result.updates} updates`,
      )
    } catch (err) {
      playWalletSound('error')
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="nav-section-body settings-scroll" data-aeon-scope="history-backup">
      <p className="settings-hint">
        Exports Wallet Toolbox data as <strong>BRC-38</strong>, encrypted to{' '}
        <strong>BRC-39</strong> (<code>wallet.brc39</code>) with Argon2id + AES-256-GCM. Not your
        recovery key — use Key slices / phrase for that. Optional URL stores the ciphertext blob
        only (no HandCash host yet — leave blank or set your own).
      </p>

      <div className="settings-form settings-form-compact">
        <div className="field">
          <label htmlFor="history-backup-url">Backup URL (optional)</label>
          <input
            id="history-backup-url"
            type="url"
            placeholder="https://your-backup.example.com"
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
        <p className="settings-hint">
          Remote path: <code>PUT/GET …/v1/wallets/&#123;identityKey&#125;/wallet.brc39</code>
        </p>
        {resolvedUrl ? (
          <p className="settings-row-desc">
            Last upload: {formatWhen(prefs.lastUploadedAt)}
            {prefs.lastError ? ` · last error: ${prefs.lastError}` : ''}
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
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        {ok ? (
          <p className="settings-hint" role="status">
            {ok}
          </p>
        ) : null}
        <div className="actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy !== null || password.length < 8}
          >
            {busy === 'file' ? 'Exporting…' : 'Download .brc39'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy !== null || password.length < 8}
            onClick={() => fileRef.current?.click()}
          >
            {busy === 'import' ? 'Importing…' : 'Import file'}
          </button>
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy !== null || password.length < 8 || !resolvedUrl}
            onClick={() => void runUpload()}
          >
            {busy === 'upload' ? 'Uploading…' : 'Upload to URL'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy !== null || password.length < 8 || !resolvedUrl}
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
    </div>
  )
}
