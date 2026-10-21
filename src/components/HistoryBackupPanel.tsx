import { Button } from '@aeon-ui/react'
import { getActiveWallet } from '../wallet/session'

import { useEffect, useRef, useState } from 'react'
import {
  exportBrc39ToFile,
  fetchRemoteBrc39Meta,
  HistoryThinOverwriteError,
  importBrc39FromFile,
  listLocalBrc39Archive,
  replaceLocalHistoryFromCloud,
  restoreLocalBrc39Archive,
  uploadBrc39Backup,
} from '../wallet/historyBackup'
import type { LocalBrc39ArchiveMeta } from '../wallet/brc39LocalArchive'
import { clearBackupBackoff } from '../wallet/backupWatchdog'

import {
  displayHistoryBackupBaseUrl,
  ensureSuggestedHistoryBackupUrl,
  getHistoryBackupPrefs,
  resolveHistoryBackupBaseUrl,
} from '../wallet/historyBackupPrefs'
import { recomposeWallet } from '../wallet/recompose'
import { refreshCloudBackupHealth } from '../wallet/cloudBackupHealth'
import { retryHistoryHostNow } from '../wallet/historyRemoteProbe'
import {
  canConfirmHistoryBackup,
  markHistoryBackupConfirmed,
  noteHistoryBackupExport,
} from '../wallet/backupStatus'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { inspectLocalToolboxState } from '../wallet/layers'
import { useAsyncAction, type AsyncActionOutcome } from '../hooks/useAsyncAction'
import { AsyncActionPrompt } from './AsyncActionPrompt'
import { ConfirmPasswordGate } from './ConfirmPasswordGate'
import { CloudUploadIcon, DownloadIcon, FileIcon } from './icons'
import { HistoryBackupUrlField, SettingsControlRow, SettingsSection } from './settings'
import { SettingsFeatureAbout } from './SettingsFeatureAbout'

function formatWhen(ts: number | null): string {
  if (!ts) return 'Never'
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return 'Never'
  }
}

type HistoryActionKind =
  | 'file'
  | 'upload'
  | 'overwrite'
  | 'restore'
  | 'import'
  | 'check'
  | 'local'

const sats = (n: number | null) => (n == null ? 'unknown balance' : `${n.toLocaleString()} sats`)

export function HistoryBackupPanel() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [prefs, setPrefs] = useState(() => getHistoryBackupPrefs())
  const [password, setPassword] = useState<string | null>(null)
  const [historyUnlocked, setHistoryUnlocked] = useState(false)
  const action = useAsyncAction<HistoryActionKind>()
  const busy = action.busy
  const [exportTick, setExportTick] = useState(0)
  const [localSnaps, setLocalSnaps] = useState<LocalBrc39ArchiveMeta[]>([])
  const [cloudDetail, setCloudDetail] = useState<string | null>(null)
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

  const fail = (title: string, outcome: AsyncActionOutcome) => {
    if (outcome.ok || outcome.error === null) return
    playWalletSound('error')
    toastError(title, outcome.error)
  }

  const checkCloud = async () => {
    playWalletSound('soft')
    await action.run('check', async () => {
      ensureSuggestedHistoryBackupUrl()
      retryHistoryHostNow()
      const health = await refreshCloudBackupHealth()
      setCloudDetail(health.message)
      setPrefs(getHistoryBackupPrefs())
      if (health.phase === 'ok') toastSuccess(health.label, health.message ?? undefined)
      else if (health.phase === 'pending')
        toastSuccess(health.label, health.message ?? 'Upload will retry automatically')
      else if (health.phase === 'error' || health.phase === 'delayed') {
        toastError(health.label, health.message ?? 'Check the URL')
      }
      else toastSuccess(health.label, health.message ?? undefined)
    })
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
    const outcome = await action.run('local', async () => {
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
    })
    fail('Local restore failed', outcome)
  }

  const runExportFile = async () => {
    if (!historyUnlocked) return
    const outcome = await action.run('file', async () => {
      const saved = await exportBrc39ToFile(password ?? '', { passwordAlreadyVerified: true })
      if (saved.saved) {
        playWalletSound('success')
        toastSuccess('History backup saved', saved.path)
        markExported()
      }
      await refreshLocalArchive()
    })
    fail('Export failed', outcome)
  }

  const uploaded = async (result: { exportedAt: number }) => {
    setPrefs(getHistoryBackupPrefs())
    playWalletSound('success')
    toastSuccess('Uploaded', formatWhen(result.exportedAt))
    markExported()
    await refreshLocalArchive()
  }

  /**
   * Guarded first: the same empty-local / thinner-than-remote check the
   * automatic path runs. Only a refusal asks to overwrite, naming both sides.
   */
  const runUpload = async () => {
    if (!historyUnlocked) return
    const guard: { refusal: string | null } = { refusal: null }
    const outcome = await action.run('upload', async () => {
      ensureSuggestedHistoryBackupUrl()
      // The operator asked for this one — never make them wait out a backoff.
      clearBackupBackoff()
      retryHistoryHostNow()
      try {
        await uploaded(await uploadBrc39Backup(password ?? '', { passwordAlreadyVerified: true }))
      } catch (err) {
        if (!(err instanceof HistoryThinOverwriteError)) throw err
        guard.refusal = err.message
      }
    })
    setPrefs(getHistoryBackupPrefs())
    if (!outcome.ok) return fail('Upload failed', outcome)
    if (guard.refusal === null) return
    const [remote, local] = await Promise.all([
      fetchRemoteBrc39Meta().catch(() => null),
      inspectLocalToolboxState().catch(() => null),
    ])
    const forced = await action.run(
      'overwrite',
      async () => {
        await uploaded(
          await uploadBrc39Backup(password ?? '', { force: true, passwordAlreadyVerified: true }),
        )
      },
      {
        confirm: {
          title: 'Overwrite the cloud copy?',
          body: remote?.exists
            ? `Cloud: ${sats(remote.spendableSats)} · ${remote.actionCount ?? '?'} actions, from ${formatWhen(remote.exportedAt)}. This device: ${sats(local?.spendableSats ?? null)} · ${local?.actionCount ?? '?'} actions. The cloud copy is replaced.`
            : 'The cloud copy could not be checked. Uploading replaces whatever is stored there.',
          confirmLabel: 'Overwrite',
          danger: true,
        },
      },
    )
    setPrefs(getHistoryBackupPrefs())
    fail('Upload failed', forced)
  }

  const runRestoreUrl = async () => {
    if (!historyUnlocked) return
    const remote = await fetchRemoteBrc39Meta().catch(() => null)
    const outcome = await action.run(
      'restore',
      async () => {
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
            (recomposed.spendableSats != null ? ` · chain ${recomposed.spendableSats} sats` : ''),
        )
      },
      {
        confirm: {
          title: 'Replace history from the cloud?',
          body: remote?.exists
            ? `Cloud copy from ${formatWhen(remote.exportedAt)} · ${sats(remote.spendableSats)} · ${remote.actionCount ?? '?'} actions. The current database stays on this device.`
            : 'No cloud copy could be read.',
          confirmLabel: 'Replace',
          danger: true,
        },
      },
    )
    fail('Restore failed', outcome)
  }

  const runImportFile = async (file: File | null) => {
    if (!file || !historyUnlocked) return
    const outcome = await action.run('import', async () => {
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
          (recomposed.spendableSats != null ? ` · chain ${recomposed.spendableSats} sats` : ''),
      )
    })
    if (fileRef.current) fileRef.current.value = ''
    fail('Import failed', outcome)
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

      <SettingsSection title="Cloud copy" part="cloud">
        <ul className="settings-list">
          <SettingsControlRow
            label="Last upload"
            icon={<CloudUploadIcon size={20} />}
            description={
              effectiveUrl
                ? `${formatWhen(prefs.lastUploadedAt)}${prefs.lastError ? ` · ${prefs.lastError}` : ''}`
                : 'No backup host set'
            }
          >
            <Button.Root
              variant="ghost"
              className="btn btn-ghost"
              disabled={busy || !effectiveUrl}
              onClick={() => void checkCloud()}
            >
              <Button.Label>{action.running('check') ? 'Checking…' : 'Check'}</Button.Label>
            </Button.Root>
          </SettingsControlRow>
          {historyUnlocked ? (
            <>
              <SettingsControlRow label="Back up now" description="Upload this wallet’s history to the host">
                <Button.Root
                  variant="ghost"
                  className="btn btn-ghost"
                  disabled={busy || !effectiveUrl}
                  onClick={() => void runUpload()}
                >
                  <Button.Label>
                    {action.running('upload') || action.running('overwrite') ? 'Backing up…' : 'Back up'}
                  </Button.Label>
                </Button.Root>
              </SettingsControlRow>
              <SettingsControlRow
                label="Replace from cloud"
                description="Swap this device’s history for the cloud copy"
              >
                <Button.Root
                  variant="ghost"
                  className="btn btn-ghost"
                  disabled={busy || !effectiveUrl}
                  onClick={() => void runRestoreUrl()}
                >
                  <Button.Label>{action.running('restore') ? 'Replacing…' : 'Replace'}</Button.Label>
                </Button.Root>
              </SettingsControlRow>
            </>
          ) : null}
        </ul>
        {cloudDetail ? (
          <p className="settings-row-desc" role="status">
            {cloudDetail}
          </p>
        ) : null}
      </SettingsSection>

      {!historyUnlocked ? (
        <ConfirmPasswordGate
          id="history-backup-password"
          title="Confirm it’s you"
          lede="Backups are sealed to your wallet key."
          actionLabel="Unlock history actions"
          onVerified={(pw) => {
            setPassword(pw)
            setHistoryUnlocked(true)
          }}
        />
      ) : (
        <>
          <SettingsSection title="Backup file" part="file">
            <ul className="settings-list">
              <SettingsControlRow
                label="Download a backup"
                icon={<DownloadIcon size={20} />}
                description="An encrypted .brc39 file of this wallet’s history"
              >
                <Button.Root
                  variant="solid"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void runExportFile()}
                >
                  <Button.Label>{action.running('file') ? 'Exporting…' : 'Download'}</Button.Label>
                </Button.Root>
              </SettingsControlRow>
              <SettingsControlRow
                label="Import a backup"
                icon={<FileIcon size={20} />}
                description="Merge a .brc39 file into this wallet"
              >
                <Button.Root
                  variant="ghost"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => fileRef.current?.click()}
                >
                  <Button.Label>{action.running('import') ? 'Importing…' : 'Choose file'}</Button.Label>
                </Button.Root>
              </SettingsControlRow>
            </ul>
            <input
              ref={fileRef}
              type="file"
              accept=".brc39,application/vnd.brc39.wallet,application/octet-stream"
              hidden
              onChange={(e) => void runImportFile(e.target.files?.[0] ?? null)}
            />
          </SettingsSection>

          <SettingsSection title="On-device snapshots" part="snapshots">
            <p className="settings-row-desc">Never overwritten. Newest first; restoring merges into this wallet.</p>
            {localSnaps.length > 0 ? (
              <ul className="settings-list">
                {localSnaps.slice(0, 8).map((snap) => (
                  <SettingsControlRow
                    key={snap.id}
                    label={formatWhen(snap.exportedAt)}
                    description={`${(snap.bytes / 1024).toFixed(1)} KB`}
                  >
                    <Button.Root
                      variant="ghost"
                      className="btn btn-ghost"
                      disabled={busy}
                      onClick={() => void runRestoreLocal(snap.id)}
                    >
                      <Button.Label>{action.running('local') ? 'Restoring…' : 'Restore'}</Button.Label>
                    </Button.Root>
                  </SettingsControlRow>
                ))}
              </ul>
            ) : (
              <p className="settings-row-desc">No snapshots yet. Export once, or spend, to write one.</p>
            )}
          </SettingsSection>

          <div className="actions" data-aeon-part="session">
            <span className="settings-row-desc">Unlocked for this session.</span>
            <Button.Root
              variant="ghost"
              className="btn btn-ghost"
              onClick={() => {
                setPassword(null)
                setHistoryUnlocked(false)
                playWalletSound('soft')
              }}
            >
              <Button.Label>Lock again</Button.Label>
            </Button.Root>
          </div>
        </>
      )}

      <div className="actions">
        <Button.Root variant="solid"
          className="btn btn-primary"
          onClick={confirmHistory}
          disabled={!canConfirm}
        >
          <Button.Label>{canConfirm ? 'History backup saved' : 'Export first'}</Button.Label>
        </Button.Root>
      </div>

      <AsyncActionPrompt action={action} />

      <SettingsFeatureAbout tags={['BRC-39']}>
        An encrypted copy of this wallet’s outputs, labels and baskets — on HandCash unless you set
        another host. Each export also writes a snapshot here that nothing later overwrites, so a
        bad upload or an emptied database cannot leave you without a copy.
      </SettingsFeatureAbout>
    </div>
  )
}
