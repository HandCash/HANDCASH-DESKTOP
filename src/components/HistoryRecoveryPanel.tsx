import { useEffect, useState } from 'react'
import { clearBackupBackoff } from '../wallet/backupWatchdog'
import {
  fetchRemoteBrc39Meta,
  replaceLocalHistoryFromCloud,
} from '../wallet/historyBackup'
import { ensureSuggestedHistoryBackupUrl } from '../wallet/historyBackupPrefs'
import { getSessionBackupPassword } from '../wallet/sessionBackupAuth'
import { recomposeWallet } from '../wallet/recompose'
import { playWalletSound } from '../wallet/soundService'
import { PasswordField } from './PasswordField'

type Props = {
  onDone: () => void
  onSkip: () => void
}

type RemoteProbe =
  | { status: 'checking' }
  | { status: 'found'; bytes: number | null }
  | { status: 'missing' }
  | { status: 'error'; message: string }

/**
 * Post-restore gate: keys are sealed; replace local toolbox state from BRC-39
 * using the root key. Optional legacy unlock password only for older blobs
 * that were encrypted before root-key history (then re-uploaded as root-key).
 */
export function HistoryRecoveryPanel({ onDone, onSkip }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [probe, setProbe] = useState<RemoteProbe>({ status: 'checking' })
  const [showLegacy, setShowLegacy] = useState(false)
  const [legacyPassword, setLegacyPassword] = useState('')

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
    setError(null)
    setBusy(true)
    try {
      ensureSuggestedHistoryBackupUrl()
      clearBackupBackoff()
      const legacy =
        legacyPassword.trim() || getSessionBackupPassword() || null
      await replaceLocalHistoryFromCloud(legacy)
      await recomposeWallet({
        password: getSessionBackupPassword(),
        history: 'skip',
        reason: 'restore-url',
      })
      playWalletSound('success')
      onDone()
    } catch (err) {
      playWalletSound('error')
      const msg = err instanceof Error ? err.message : String(err)
      if (/decrypt|password|passphrase|auth|mac|argon|gcm|cipher|invalid/i.test(msg)) {
        setShowLegacy(true)
        setError(
          'This cloud backup was made with an older unlock password. Enter that password once below — we’ll re-seal history to your wallet key.',
        )
      } else {
        setError(msg)
      }
    } finally {
      setBusy(false)
    }
  }

  const remoteNote =
    probe.status === 'checking'
      ? 'Looking for your history backup…'
      : probe.status === 'found'
        ? 'History backup found — restore it to recover balance, activity, friends, and apps.'
        : probe.status === 'missing'
          ? 'No history backup at the default URL yet. You can skip and rely on chain scan, or check Settings → History later.'
          : `Could not reach history host: ${probe.message}`

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

      {error ? (
        <p className="wallet-sync-note is-error" role="alert">
          {error}
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
            disabled={busy}
          />
          <p className="password-hint">
            Only needed for backups made before root-key history. After this restore we
            re-upload sealed to your key.
          </p>
        </>
      ) : null}

      <div className="auth-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn-primary primary"
          disabled={busy || probe.status === 'checking'}
          onClick={() => void restore()}
        >
          {busy ? 'Restoring…' : 'Restore history'}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy}
          onClick={onSkip}
        >
          Skip for now
        </button>
      </div>
    </div>
  )
}
