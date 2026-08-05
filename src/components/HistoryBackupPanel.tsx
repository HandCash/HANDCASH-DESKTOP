import { useRef, useState } from 'react'
import {
  downloadAndRestoreBrc39Backup,
  exportBrc39ToFile,
  importBrc39FromFile,
  uploadBrc39Backup,
} from '../wallet/historyBackup'
import {
  displayHistoryBackupBaseUrl,
  ensureSuggestedHistoryBackupUrl,
  getHistoryBackupPrefs,
  resolveHistoryBackupBaseUrl,
} from '../wallet/historyBackupPrefs'
import { recomposeWallet } from '../wallet/recompose'
import { refreshCloudBackupHealth } from '../wallet/cloudBackupHealth'
import {
  canConfirmHistoryBackup,
  markHistoryBackupConfirmed,
  noteHistoryBackupExport,
} from '../wallet/backupStatus'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { ConfirmPasswordGate } from './ConfirmPasswordGate'
import { HistoryBackupUrlField } from './settings'
import { SettingsFeatureAbout } from './SettingsFeatureAbout'

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
  const [password, setPassword] = useState<string | null>(null)
  const [busy, setBusy] = useState<'file' | 'upload' | 'restore' | 'import' | 'check' | null>(null)
  const [exportTick, setExportTick] = useState(0)
  const canConfirm = exportTick >= 0 && canConfirmHistoryBackup()
  const resolvedUrl = resolveHistoryBackupBaseUrl(prefs)
  const effectiveUrl = resolvedUrl || displayHistoryBackupBaseUrl(prefs)

  const checkCloud = async () => {
    playWalletSound('soft')
    setBusy('check')
    try {
      ensureSuggestedHistoryBackupUrl()
      const health = await refreshCloudBackupHealth()
      setPrefs(getHistoryBackupPrefs())
      if (health.phase === 'ok') toastSuccess(health.label, health.message ?? undefined)
      else if (health.phase === 'pending')
        toastSuccess(health.label, health.message ?? 'Upload will retry automatically')
      else if (health.phase === 'error') toastError(health.label, health.message ?? 'Check the URL')
      else toastSuccess(health.label, health.message ?? undefined)
    } finally {
      setBusy(null)
    }
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

  const runExportFile = async () => {
    if (!password) return
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
    if (!password) return
    setBusy('upload')
    try {
      ensureSuggestedHistoryBackupUrl()
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
    if (!password) return
    setBusy('restore')
    try {
      ensureSuggestedHistoryBackupUrl()
      const result = await downloadAndRestoreBrc39Backup(password)
      const recomposed = await recomposeWallet({
        password,
        history: 'skip',
        reason: 'restore-url',
      })
      playWalletSound('success')
      toastSuccess(
        'Restored from history',
        `${result.inserts + result.updates} changes` +
          (recomposed.spendableSats != null
            ? ` · chain ${recomposed.spendableSats} sats`
            : ''),
      )
    } catch (err) {
      playWalletSound('error')
      toastError('Restore failed', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const runImportFile = async (file: File | null) => {
    if (!file || !password) return
    setBusy('import')
    try {
      const result = await importBrc39FromFile(file, password)
      const recomposed = await recomposeWallet({
        password,
        history: 'skip',
        reason: 'import-file',
      })
      playWalletSound('success')
      toastSuccess(
        'Imported history',
        `${result.inserts + result.updates} changes` +
          (recomposed.spendableSats != null
            ? ` · chain ${recomposed.spendableSats} sats`
            : ''),
      )
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
        Shared history backup. The same URL on every device is <strong>required</strong> to link
        installs (Settings → Use on another device). Restore recomposes from history then checks
        the chain; chain ingest alone cannot rebuild P2P / managed-change state.
      </p>

      <HistoryBackupUrlField
        id="history-backup-url"
        label="Backup URL (required to link devices)"
        onSaved={(baseUrl) => {
          setPrefs(getHistoryBackupPrefs())
          if (baseUrl) void refreshCloudBackupHealth().then(() => setPrefs(getHistoryBackupPrefs()))
        }}
      />

      <div className="actions" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy !== null || !effectiveUrl}
          onClick={() => void checkCloud()}
        >
          {busy === 'check' ? 'Checking…' : 'Check cloud'}
        </button>
        {effectiveUrl ? (
          <span className="settings-row-desc">
            Last upload: {formatWhen(prefs.lastUploadedAt)}
            {prefs.lastError ? ` · ${prefs.lastError}` : ''}
          </span>
        ) : null}
      </div>

      {!password ? (
        <ConfirmPasswordGate
          id="history-backup-password"
          title="Confirm it’s you"
          lede="Export and restore use the same unlock password that encrypts your history backup."
          actionLabel="Unlock history actions"
          onVerified={(pw) => setPassword(pw)}
        />
      ) : (
        <div className="settings-form settings-form-compact">
          <p className="settings-row-desc">Unlocked for this session — export or restore below.</p>
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy !== null}
              onClick={() => void runExportFile()}
            >
              {busy === 'file' ? 'Exporting…' : 'Download .brc39'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy !== null}
              onClick={() => fileRef.current?.click()}
            >
              {busy === 'import' ? 'Importing…' : 'Import file'}
            </button>
          </div>
          <div className="actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy !== null || !effectiveUrl}
              onClick={() => void runUpload()}
            >
              {busy === 'upload' ? 'Uploading…' : 'Upload to URL'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy !== null || !effectiveUrl}
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
          <div className="actions" style={{ marginTop: 4 }}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setPassword(null)
                playWalletSound('soft')
              }}
            >
              Lock again
            </button>
          </div>
        </div>
      )}

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

      <SettingsFeatureAbout tags={['BRC-39']}>
        Encrypted wallet history blob (outs, labels, baskets). One object per identity on your
        backup host — used for multi-device parity, not key recovery.
      </SettingsFeatureAbout>
    </div>
  )
}
