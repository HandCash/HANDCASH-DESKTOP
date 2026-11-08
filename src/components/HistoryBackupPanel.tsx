import { Button } from '@aeon-ui/react'
import { getActiveWallet } from '../wallet/session'

import { useEffect, useRef, useState } from 'react'
import {
  downloadAndRestoreBrc39Backup,
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
import { inspectLocalToolboxState, type LocalToolboxState } from '../wallet/layers'
import { useAsyncAction, type AsyncActionOutcome } from '../hooks/useAsyncAction'
import { AsyncActionPrompt } from './AsyncActionPrompt'
import { ConfirmPasswordGate } from './ConfirmPasswordGate'
import { CloudUploadIcon, DownloadIcon, FileIcon, WarningIcon, SyncIcon, DatabaseIcon } from './icons'
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
  | 'restore-merge'
  | 'restore-replace'
  | 'import'
  | 'check'
  | 'local'

const sats = (n: number | null) => (n == null ? 'unknown balance' : `${n.toLocaleString()} sats`)

interface CloudLocalComparison {
  remote: {
    exists: boolean
    exportedAt: number | null
    spendableSats: number | null
    actionCount: number | null
  } | null
  local: LocalToolboxState | null
}

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
  const [comparison, setComparison] = useState<CloudLocalComparison | null>(null)
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

  const refreshComparison = async () => {
    const [remote, local] = await Promise.all([
      fetchRemoteBrc39Meta().catch(() => null),
      inspectLocalToolboxState().catch(() => null),
    ])
    setComparison({ remote, local })
  }

  useEffect(() => {
    void refreshLocalArchive()
    void refreshComparison()
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
      await refreshComparison()
      if (health.phase === 'ok') toastSuccess(health.label, health.message ?? undefined)
      else if (health.phase === 'pending')
        toastSuccess(health.label, health.message ?? 'Upload will retry automatically')
      else if (health.phase === 'error' || health.phase === 'delayed') {
        toastError(health.label, health.message ?? 'Check the connection')
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
    await refreshComparison()
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
    await refreshComparison()
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
          body: comparison?.remote?.exists
            ? `Cloud: ${sats(comparison.remote.spendableSats)} · ${comparison.remote.actionCount ?? '?'} actions, from ${formatWhen(comparison.remote.exportedAt)}. This device: ${sats(comparison.local?.spendableSats ?? null)} · ${comparison.local?.actionCount ?? '?'} actions. The cloud copy is replaced.`
            : 'The cloud copy could not be checked. Uploading replaces whatever is stored there.',
          confirmLabel: 'Overwrite',
          danger: true,
        },
      },
    )
    setPrefs(getHistoryBackupPrefs())
    fail('Upload failed', forced)
  }

  const runRestoreMerge = async () => {
    if (!historyUnlocked) return
    await refreshComparison()
    const outcome = await action.run(
      'restore-merge',
      async () => {
        ensureSuggestedHistoryBackupUrl()
        clearBackupBackoff()
        // Safe merge: downloads cloud backup and merges into local history
        // Local data not in cloud is preserved. Cloud data not local is added.
        const result = await downloadAndRestoreBrc39Backup(password)
        const recomposed = await recomposeWallet({
          password: password ?? undefined,
          history: 'skip',
          reason: 'restore-merge',
        })
        playWalletSound('success')
        toastSuccess(
          'Restored from cloud (merged)',
          `${result.inserts + result.updates} changes` +
            (recomposed.spendableSats != null ? ` · chain ${recomposed.spendableSats} sats` : ''),
        )
      },
      {
        confirm: {
          title: 'Restore history from cloud (merge)?',
          body: comparison?.remote?.exists
            ? `Cloud copy from ${formatWhen(comparison.remote.exportedAt)} · ${sats(comparison.remote.spendableSats)} · ${comparison.remote.actionCount ?? '?'} actions. This device: ${sats(comparison.local?.spendableSats ?? null)} · ${comparison.local?.actionCount ?? '?'} actions. Cloud data will be merged; local data not in cloud is kept.`
            : 'No cloud copy could be read.',
          confirmLabel: 'Restore',
          danger: false,
        },
      },
    )
    fail('Restore failed', outcome)
    await refreshComparison()
  }

  const runRestoreReplace = async () => {
    if (!historyUnlocked) return
    await refreshComparison()
    
    // First confirmation: show detailed comparison
    const firstConfirmed = await action.run(
      'restore-replace',
      async () => {
        // This is just to show the confirmation dialog, actual work is in second step
      },
      {
        confirm: {
          title: '⚠ Replace ALL history from cloud?',
          body: comparison?.remote?.exists
            ? `This DELETES this device's history and replaces it with the cloud copy.\n\nCloud: ${formatWhen(comparison.remote.exportedAt)} · ${sats(comparison.remote.spendableSats)} · ${comparison.remote.actionCount ?? '?'} actions\n\nThis device: ${sats(comparison.local?.spendableSats ?? null)} · ${comparison.local?.actionCount ?? '?'} actions\n\nP2P payments, tokens, and local labels NOT in the cloud will be LOST.`
            : 'No cloud copy could be read. Replace would leave an empty history.',
          confirmLabel: 'I understand — proceed',
          danger: true,
        },
      },
    )
    if (!firstConfirmed.ok) return

    // Second confirmation: explicit final warning
    const secondConfirmed = await action.run(
      'restore-replace',
      async () => {},
      {
        confirm: {
          title: 'Final warning: this cannot be undone',
          body: 'The current local history database will be permanently replaced. Only the cloud copy will remain. If the cloud copy is older or incomplete, that data is gone forever.',
          confirmLabel: 'Replace everything',
          danger: true,
        },
      },
    )
    if (!secondConfirmed.ok) return

    // Actually perform the replace
    const outcome = await action.run(
      'restore-replace',
      async () => {
        ensureSuggestedHistoryBackupUrl()
        clearBackupBackoff()
        // DANGEROUS: Full replace of local database with cloud copy
        const result = await replaceLocalHistoryFromCloud(password)
        const recomposed = await recomposeWallet({
          password: password ?? undefined,
          history: 'skip',
          reason: 'restore-replace',
        })
        playWalletSound('success')
        toastSuccess(
          'Replaced from cloud',
          `${result.inserts + result.updates} changes` +
            (recomposed.spendableSats != null ? ` · chain ${recomposed.spendableSats} sats` : ''),
        )
      },
    )
    fail('Replace failed', outcome)
    await refreshComparison()
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
        'Imported history (merged)',
        `${result.inserts + result.updates} changes` +
          (recomposed.spendableSats != null ? ` · chain ${recomposed.spendableSats} sats` : ''),
      )
    })
    if (fileRef.current) fileRef.current.value = ''
    fail('Import failed', outcome)
  }

  // Render comparison panel
  const renderComparison = () => {
    if (!comparison) return null
    const { remote, local } = comparison
    
    return (
      <div className="history-comparison" data-aeon-part="comparison">
        <h4 className="history-comparison-title">Cloud vs This Device</h4>
        <div className="history-comparison-grid">
          <div className="history-comparison-col">
            <span className="history-comparison-label">Cloud copy</span>
            {remote?.exists ? (
              <>
                <div className="history-comparison-value">
                  <SyncIcon size={16} /> {formatWhen(remote.exportedAt)}
                </div>
                <div className="history-comparison-value">
                  {sats(remote.spendableSats)}
                </div>
                <div className="history-comparison-value">
                  {remote.actionCount ?? '?'} actions
                </div>
              </>
            ) : (
              <div className="history-comparison-value empty">Not available</div>
            )}
          </div>
          <div className="history-comparison-divider" />
          <div className="history-comparison-col">
            <span className="history-comparison-label">This device</span>
            {local ? (
              <>
                <div className="history-comparison-value">
                  <DatabaseIcon size={16} /> Now
                </div>
                <div className="history-comparison-value">
                  {sats(local.spendableSats)}
                </div>
                <div className="history-comparison-value">
                  {local.actionCount} actions
                </div>
              </>
            ) : (
              <div className="history-comparison-value empty">Unable to read</div>
            )}
          </div>
        </div>
        {remote?.exists && local && (
          <p className="history-comparison-hint">
            {remote.actionCount !== null && local.actionCount > (remote.actionCount ?? 0) && (
              <span className="warning">
                <WarningIcon size={14} /> This device has more actions than the cloud. Restore (merge) keeps them; Replace loses them.
              </span>
            )}
            {remote.actionCount !== null && local.actionCount < (remote.actionCount ?? 0) && (
              <span className="info">
                <SyncIcon size={14} /> Cloud has more actions. Restore (merge) adds them; Replace keeps only cloud.
              </span>
            )}
            {remote.spendableSats !== null && local.spendableSats > (remote.spendableSats ?? 0) && (
              <span className="warning">
                <WarningIcon size={14} /> This device has more spendable sats. Restore (merge) keeps them; Replace loses them.
              </span>
            )}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="nav-section-body settings-scroll" data-aeon-scope="history-backup">
      <p className="settings-hint">
        Direct payments need history backup; Refresh only reads the chain.
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
        {renderComparison()}
        
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
              <SettingsControlRow label="Back up now" description="Upload this wallet's history to the host">
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
                label="Merge from cloud"
                icon={<SyncIcon size={20} />}
                description="Download cloud backup and merge into this device — keeps local data not in cloud"
              >
                <Button.Root
                  variant="solid"
                  className="btn btn-primary"
                  disabled={busy || !effectiveUrl}
                  onClick={() => void runRestoreMerge()}
                >
                  <Button.Label>{action.running('restore-merge') ? 'Merging…' : 'Merge from cloud'}</Button.Label>
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
          title="Confirm it's you"
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
                description="An encrypted .brc39 file of this wallet's history"
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
            <p className="settings-row-desc">Never overwritten; newest first. Restore merges history.</p>
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

          <SettingsSection title="Dangerous operations" part="dangerous">
            <p className="settings-row-desc" style={{color: 'var(--color-error)'}}>
              These operations destroy local data. Only use them if you understand the consequences.
            </p>
            <ul className="settings-list">
              <SettingsControlRow
                label="Replace from cloud"
                icon={<WarningIcon size={20} />}
                description="DELETE this device's history and replace with cloud copy — loses local P2P payments, tokens, labels"
              >
                <Button.Root
                  variant="ghost"
                  className="btn btn-ghost btn-danger"
                  disabled={busy || !effectiveUrl}
                  onClick={() => void runRestoreReplace()}
                >
                  <Button.Label>{action.running('restore-replace') ? 'Replacing…' : 'Replace'}</Button.Label>
                </Button.Root>
              </SettingsControlRow>
            </ul>
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
        Encrypted outputs, labels and baskets, hosted by HandCash or your chosen host.
        Each export also keeps a local snapshot.
      </SettingsFeatureAbout>
    </div>
  )
}