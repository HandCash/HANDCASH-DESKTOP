import { getActiveWallet } from '../wallet/session'

import { useEffect, useRef, useState } from 'react'
import { clearBackupBackoff } from '../wallet/backupWatchdog'
import {
  fetchRemoteBrc39Meta,
  replaceLocalHistoryFromCloud,
} from '../wallet/historyBackup'
import { ensureSuggestedHistoryBackupUrl } from '../wallet/historyBackupPrefs'
import { recomposeWallet } from '../wallet/recompose'
import { fetchBalanceSats} from '../wallet/session'
import { getSessionBackupPassword } from '../wallet/sessionBackupAuth'
import { playWalletSound } from '../wallet/soundService'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { PasswordField } from './PasswordField'

type Props = {
  onDone: (balanceSats: number) => void
  onSkip: () => void
}

type RemoteProbe =
  | { status: 'checking' }
  | { status: 'found'; bytes: number | null }
  | { status: 'missing' }
  | { status: 'error'; message: string }

/**
 * Post-restore gate: keys are sealed; replace local toolbox state from BRC-39
 * using the root key. When a remote backup exists we pull automatically —
 * local IndexedDB is wiped first, then merged from cloud (never an empty PUT
 * over remote; push stays deferred on the restore path).
 *
 * Optional legacy unlock password only for older blobs encrypted before
 * root-key history (then re-uploaded as root-key).
 */
export function HistoryRecoveryPanel({ onDone, onSkip }: Props) {
  const recovery = useAsyncAction<'restore'>()
  const [probe, setProbe] = useState<RemoteProbe>({ status: 'checking' })
  const [showLegacy, setShowLegacy] = useState(false)
  const [legacyPassword, setLegacyPassword] = useState('')
  const autoRestoreStarted = useRef(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        ensureSuggestedHistoryBackupUrl()
        const remote = await fetchRemoteBrc39Meta()
        if (cancelled) return
        if (remote?.exists) {
          setProbe({ status: 'found', bytes: remote.bytes ?? null })
        } else {
          setProbe({ status: 'missing' })
        }
      } catch (err) {
        if (cancelled) return
        setProbe({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const restore = async () => {
    let balanceSats = 0
    const outcome = await recovery.run('restore', async () => {
      try {
        ensureSuggestedHistoryBackupUrl()
        clearBackupBackoff()
        const legacy =
          legacyPassword.trim() || getSessionBackupPassword() || null
        // Wipe empty local toolbox, then pull remote — pull-only; guarded push
        // is deferred until after the wallet UI is free (historyEmptyGuard).
        await replaceLocalHistoryFromCloud(legacy)
        const recomposed = await recomposeWallet({
          password: getSessionBackupPassword(),
          history: 'skip',
          reason: 'restore-url',
        })
        balanceSats = recomposed.spendableSats ?? -1
        if (balanceSats < 0) {
          const active = getActiveWallet()
          balanceSats = active ? await fetchBalanceSats(active.wallet) : 0
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/decrypt|password|passphrase|auth|mac|argon|gcm|cipher|invalid/i.test(msg)) {
          setShowLegacy(true)
          throw new Error(
            'This cloud backup was made with an older unlock password. Enter that password once below — we’ll re-seal history to your wallet key.',
          )
        }
        throw err
      }
    })
    if (outcome.ok) {
      playWalletSound('success')
      onDone(balanceSats)
    } else if (outcome.error) {
      playWalletSound('error')
    }
  }

  useEffect(() => {
    if (probe.status !== 'found' || autoRestoreStarted.current || showLegacy) return
    autoRestoreStarted.current = true
    void restore()
  }, [probe.status, showLegacy])

  const remoteNote =
    probe.status === 'checking'
      ? 'Looking for your history backup…'
      : probe.status === 'found'
        ? recovery.busy
          ? 'History backup found — restoring balance, activity, friends, and apps…'
          : 'History backup found — restoring automatically.'
        : probe.status === 'missing'
          ? 'No history backup on HandCash yet. You can enter with a chain scan only, or check Settings → History later.'
          : `Could not reach history host: ${probe.message}`

  const canSkip = probe.status === 'missing' || probe.status === 'error'
  const showRestoreButton =
    showLegacy || probe.status === 'error' || (probe.status === 'found' && Boolean(recovery.error))

  return (
    <div className="wallet-setup-config" data-aeon-scope="history-recovery">
      <h2>Restore your history</h2>
      <p className="auth-lede">
        Keys are on this device. Activity, UTXOs, friends, and connected apps live in
        your encrypted history backup — sealed to this wallet’s key, not your unlock
        password.
      </p>
      <p className="auth-lede" role="status">
        {remoteNote}
      </p>

      {recovery.error ? (
        <p className="wallet-sync-note is-error" role="alert">
          {recovery.error}
        </p>
      ) : null}

      {showLegacy ? (
        <>
          <PasswordField
            id="history-legacy-password"
            label="Previous unlock password (one-time)"
            placeholder="Password that encrypted the old backup"
            value={legacyPassword}
            onChange={(e) => setLegacyPassword(e.target.value)}
            autoComplete="current-password"
            disabled={recovery.busy}
          />
          <p className="password-hint">
            Only needed for backups made before root-key history. After this restore we
            re-upload sealed to your key.
          </p>
        </>
      ) : null}

      <div
        className="auth-actions"
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
        data-aeon-part="history-recovery-actions"
        data-aeon-state={recovery.stateAttr}
      >
        {showRestoreButton ? (
          <button
            type="button"
            className="btn btn-primary primary"
            disabled={recovery.busy || probe.status === 'checking'}
            onClick={() => void restore()}
          >
            {recovery.busy ? 'Restoring…' : 'Restore history'}
          </button>
        ) : null}
        {canSkip ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={recovery.busy}
            onClick={onSkip}
          >
            {probe.status === 'missing' ? 'Continue without history' : 'Skip for now'}
          </button>
        ) : null}
      </div>
    </div>
  )
}
