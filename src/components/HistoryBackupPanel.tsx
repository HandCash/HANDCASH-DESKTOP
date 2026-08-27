import { useEffect, useRef, useState } from 'react'
import {
  exportBrc39ToFile,
  importBrc39FromFile,
  listLocalBrc39Archive,
  replaceLocalHistoryFromCloud,
  restoreLocalBrc39Archive,
  uploadBrc39Backup,
} from '../wallet/historyBackup'
import type { LocalBrc39ArchiveMeta } from '../wallet/brc39LocalArchive'
import { clearBackupBackoff } from '../wallet/backupWatchdog'
import { getActiveWallet } from '../wallet/session'
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
  const [historyUnlocked, setHistoryUnlocked] = useState(false)
  const [busy, setBusy] = useState<
    'file' | 'upload' | 'restore' | 'import' | 'check' | 'local' | null
  >(null)
  const [exportTick, setExportTick] = useState(0)
  const [localSnaps, setLocalSnaps] = useState<LocalBrc39ArchiveMeta[]>([])
  const canConfirm = exportTick >= 0 && canConfirmHistoryBackup()
  const resolvedUrl = resolveHistoryBackupBaseUrl(prefs)
  const effectiveUrl = resolvedUrl || displayHistoryBackupBaseUrl(prefs)

  const refreshLocalArchive = async () => {
    const id = getActiveWallet()?.identityKey
    if (!id) {
      setLocalSnaps([])
      return
    }
    setLocalSnaps(await listLocalBrc39Archive(id))
  }

  useEffect(() => {
    void refreshLocalArchive()
  }, [historyUnlocked, exportTick])

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

  const runRestoreLocal = async (snapshotId: string) => {
    if (!historyUnlocked) return
    setBusy('local')
    try {
      const result = await restoreLocalBrc39Archive(password, snapshotId)
      const recomposed = await recomposeWallet({
        password: password ?? undefined,
        history: 'skip',
        chain: true,
      })
      playWalletSound('success')
      toastSuccess(
        'Restored local UTXO snapshot',
        `${result.inserts + result.updates} changes · balance ${recomposed.spendableSats ?? '—'} sats`,
      )
      await refreshLocalArchive()
    } catch (err) {
      playWalletSound('error')
      toastError('Local restore failed', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const runExportFile = async () => {
    if (!historyUnlocked) return
    setBusy('file')
    try {
      await exportBrc39ToFile(password ?? '', { passwordAlreadyVerified: true })
      playWalletSound('success')
      toastSuccess('Downloaded wallet.brc39')
      markExported()
      await refreshLocalArchive()
    } catch (err) {
      playWalletSound('error')
      toastError('Export failed', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const runUpload = async () => {
    if (!historyUnlocked) return
    setBusy('upload')
    try {
      ensureSuggestedHistoryBackupUrl()
      // The operator asked for this one — never make them wait out a backoff.
      clearBackupBackoff()
      const result = await uploadBrc39Backup(password ?? '', {
        force: true,
        passwordAlreadyVerified: true,
      })
      setPrefs(getHistoryBackupPrefs())
      playWalletSound('success')
      toastSuccess('Uploaded', formatWhen(result.exportedAt))
      markExported()
      await refreshLocalArchive()
    } catch (err) {
      playWalletSound('error')
      toastError('Upload failed', err instanceof Error ? err.message : String(err))
      setPrefs(getHistoryBackupPrefs())
    } finally {
      setBusy(null)
    }
  }

  const runRestoreUrl = async () => {
    if (!historyUnlocked) return
    setBusy('restore')
    try {
      ensureSuggestedHistoryBackupUrl()
      clearBackupBackoff()
      // Wipe toolbox IDB then pull — merge alone can under-restore after a
      // soft-latch race left local rows that win LWW over cloud spendable outs.
      const result = await replaceLocalHistoryFromCloud(password)
      const recomposed = await recomposeWallet({
        password: password ?? undefined,
        history: 'skip',
        reason: 'restore-url',
      })
      playWalletSound('success')
      toastSuccess(
        'Replaced from history',
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
    if (!file || !historyUnlocked) return
    setBusy('import')
    try {
      const result = await importBrc39FromFile(file, password)
      const recomposed = await recomposeWallet({
        password: password ?? undefined,
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
        Refresh reads the chain; only this backup restores payments you sent and received directly.
      </p>

      <HistoryBackupUrlField
        id="history-backup-url"
        label="History backup URL"
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

      {!historyUnlocked ? (
        <ConfirmPasswordGate
          id="history-backup-password"
          title="Confirm it’s you"
          lede="Confirm with device unlock or your HandCash password. Backups are sealed to your wallet key."
          actionLabel="Unlock history actions"
          onVerified={(pw) => {
            setPassword(pw)
            setHistoryUnlocked(true)
          }}
        />
      ) : (
        <div className="settings-form settings-form-compact">
          <p className="settings-row-desc">Unlocked for this session.</p>
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
              title="May overwrite a fuller cloud copy"
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
              {busy === 'restore' ? 'Replacing…' : 'Replace from cloud'}
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".brc39,application/vnd.brc39.wallet,application/octet-stream"
            hidden
            onChange={(e) => void runImportFile(e.target.files?.[0] ?? null)}
          />

          {localSnaps.length > 0 ? (
            <div className="settings-form settings-form-compact" style={{ marginTop: 12 }}>
              <p className="settings-row-label">On-device snapshots</p>
              <p className="settings-row-desc">
                Never overwritten. Newest first; restore merges into this wallet.
              </p>
              <ul className="settings-list" style={{ margin: '8px 0 0', padding: 0, listStyle: 'none' }}>
                {localSnaps.slice(0, 8).map((snap) => (
                  <li
                    key={snap.id}
                    className="settings-row"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      padding: '6px 0',
                    }}
                  >
                    <span className="settings-row-desc">
                      {formatWhen(snap.exportedAt)} · {(snap.bytes / 1024).toFixed(1)} KB
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={busy !== null}
                      onClick={() => void runRestoreLocal(snap.id)}
                    >
                      {busy === 'local' ? 'Restoring…' : 'Restore'}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="settings-row-desc" style={{ marginTop: 8 }}>
              No snapshots yet — export once, or spend to write one automatically.
            </p>
          )}

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
        An encrypted copy of this wallet’s outputs, labels and baskets — on HandCash unless you set
        another host. Each export also writes a snapshot here that nothing later overwrites, so a
        bad upload or an emptied database cannot leave you without a copy.
      </SettingsFeatureAbout>
    </div>
  )
}
