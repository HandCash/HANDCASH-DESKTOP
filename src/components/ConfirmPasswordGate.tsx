import { useEffect, useState, type FormEvent } from 'react'
import {
  readVaultUnlockFactors,
  unlockVault,
  unlockVaultWithDevice,
} from '../wallet/vault'
import { UNLOCK_PASSWORD_MIN_LENGTH } from '../wallet/passwordPolicy'
import { playWalletSound } from '../wallet/soundService'
import { PasswordField } from './PasswordField'

type Props = {
  title: string
  lede: string
  /** Primary button while locked. */
  actionLabel?: string
  /** Accessible id for the password field. */
  id?: string
  /**
   * Called after unlock verifies.
   * Password is null when verification used the device factor only.
   */
  onVerified: (password: string | null) => void | Promise<void>
  /** Force password path (e.g. change/remove password). */
  requirePassword?: boolean
  onCancel?: () => void
}

/**
 * Re-auth before sensitive settings work.
 * Prefers device unlock when enrolled; falls back to HandCash password.
 */
export function ConfirmPasswordGate({
  title,
  lede,
  actionLabel = 'Continue',
  id = 'confirm-password',
  onVerified,
  requirePassword = false,
  onCancel,
}: Props) {
  const factors = readVaultUnlockFactors()
  const canDevice = !requirePassword && factors.device
  const canPassword = factors.password
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [preferDevice, setPreferDevice] = useState(canDevice)

  useEffect(() => {
    if (!preferDevice || busy) return
    let cancelled = false
    ;(async () => {
      setBusy(true)
      setError(null)
      try {
        await unlockVaultWithDevice('Confirm it’s you')
        if (cancelled) return
        playWalletSound('unlock')
        await onVerified(null)
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        if (message !== 'cancelled') {
          playWalletSound('error')
          setError(message)
        }
        if (canPassword) setPreferDevice(false)
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // Auto-prompt once when the gate opens with device preferred.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!canPassword) {
      setError('No HandCash password on this wallet. Use device unlock.')
      playWalletSound('deny')
      return
    }
    if (password.length < UNLOCK_PASSWORD_MIN_LENGTH) {
      setError(`Password must be at least ${UNLOCK_PASSWORD_MIN_LENGTH} characters`)
      playWalletSound('deny')
      return
    }
    setBusy(true)
    try {
      await unlockVault(password)
      playWalletSound('unlock')
      await onVerified(password)
    } catch (err) {
      playWalletSound('error')
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="confirm-password-gate" data-aeon-scope="confirm-password">
      <div className="confirm-password-copy">
        <h3 className="confirm-password-title">{title}</h3>
        <p className="confirm-password-lede">{lede}</p>
      </div>

      {preferDevice && canDevice ? (
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => {
              setPreferDevice(true)
              setBusy(true)
              setError(null)
              void unlockVaultWithDevice('Confirm it’s you')
                .then(async () => {
                  playWalletSound('unlock')
                  await onVerified(null)
                })
                .catch((err) => {
                  const message = err instanceof Error ? err.message : String(err)
                  if (message !== 'cancelled') {
                    playWalletSound('error')
                    setError(message)
                  }
                  if (canPassword) setPreferDevice(false)
                })
                .finally(() => setBusy(false))
            }}
          >
            {busy ? 'Waiting…' : 'Use device unlock'}
          </button>
          {canPassword ? (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => setPreferDevice(false)}
            >
              Use HandCash password
            </button>
          ) : null}
          {onCancel ? (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
          ) : null}
        </div>
      ) : (
        <form className="settings-form settings-form-compact" onSubmit={(e) => void submit(e)}>
          <PasswordField
            id={id}
            label="HandCash password"
            autoComplete="current-password"
            placeholder="Your unlock password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            disabled={busy || !canPassword}
          />
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || !canPassword || password.length < UNLOCK_PASSWORD_MIN_LENGTH}
            >
              {busy ? 'Checking…' : actionLabel}
            </button>
            {canDevice && !requirePassword ? (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => setPreferDevice(true)}
              >
                Use device unlock
              </button>
            ) : null}
            {onCancel ? (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      )}

      {preferDevice && canDevice && error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
