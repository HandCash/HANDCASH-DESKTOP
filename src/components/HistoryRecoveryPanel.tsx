import { useEffect, useState } from 'react'
import { clearBackupBackoff } from '../wallet/backupWatchdog'
import {
  downloadAndRestoreBrc39Backup,
  fetchRemoteBrc39Meta,
} from '../wallet/historyBackup'
import { ensureSuggestedHistoryBackupUrl } from '../wallet/historyBackupPrefs'
import { recomposeWallet } from '../wallet/recompose'
import { playWalletSound } from '../wallet/soundService'
import { PasswordField } from './PasswordField'

type Props = {
  /** Vault password just set on this device — history blob may use the same. */
  initialPassword: string
  onDone: (historyPassword: string) => void
  onSkip: () => void
}

type RemoteProbe =
  | { status: 'checking' }
  | { status: 'found'; bytes: number | null }
  | { status: 'missing' }
  | { status: 'error'; message: string }

/**
 * Post-restore gate: keys are sealed; pull BRC-39 so balance, activity, friends,
 * and connected apps return before entering the wallet.
 */
export function HistoryRecoveryPanel({
  initialPassword,
  onDone,
  onSkip,
}: Props) {
  const [password, setPassword] = useState(initialPassword)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [probe, setProbe] = useState<RemoteProbe>({ status: 'checking' })

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
    if (!password.trim()) {
      setError('Enter the password that encrypted your history backup')
      return
    }
    setBusy(true)
    try {
      ensureSuggestedHistoryBackupUrl()
      clearBackupBackoff()
      await downloadAndRestoreBrc39Backup(password)
      await recomposeWallet({
        password,
        history: 'skip',
        reason: 'restore-url',
      })
      playWalletSound('success')
      onDone(password)
    } catch (err) {
      playWalletSound('error')
      const msg = err instanceof Error ? err.message : String(err)
      if (/decrypt|password|passphrase|auth|mac|argon|gcm|cipher|invalid/i.test(msg)) {
        setError(
          'That password could not decrypt the history backup. Use the unlock password from the device that uploaded it.',
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
        ? 'History backup found on BRC-CLOUD — restore it to recover balance, activity, friends, and apps.'
        : probe.status === 'missing'
          ? 'No history backup at the default URL yet. You can skip and rely on chain scan, or check Settings → History later.'
          : `Could not reach history host: ${probe.message}`

  return (
    <div className="wallet-setup-config" data-aeon-scope="history-recovery">
      <h2>Restore your history</h2>
      <p className="auth-lede">
        Keys are on this device. Activity, UTXOs, friends, and connected apps live in
        your encrypted history backup — restore them before opening the wallet.
      </p>
      <p className="auth-lede" role="status">
        {remoteNote}
      </p>

      <PasswordField
        id="history-recovery-password"
        label="History backup password"
        placeholder="Usually your previous unlock password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        autoFocus
        disabled={busy}
      />
      <p className="password-hint">
        Same password as the device that uploaded the backup (often your old unlock
        password).
      </p>

      {error ? (
        <p className="wallet-sync-note is-error" role="alert">
          {error}
        </p>
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
