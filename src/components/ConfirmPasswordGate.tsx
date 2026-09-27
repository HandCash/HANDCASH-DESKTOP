import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  readVaultUnlockFactors,
  unlockVault,
  unlockVaultWithDevice,
} from '../wallet/vault'
import { UNLOCK_PASSWORD_MIN_LENGTH } from '../wallet/passwordPolicy'
import { playWalletSound } from '../wallet/soundService'
import { useAsyncAction } from '../hooks/useAsyncAction'
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
 * One exclusive verification (`device` | `password`) at a time.
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
  /** Synchronous policy failures; the async failure lives in the chart. */
  const [formError, setFormError] = useState<string | null>(null)
  const [preferDevice, setPreferDevice] = useState(canDevice)
  const verify = useAsyncAction<'device' | 'password'>()
  const live = useRef(true)

  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const verifyWithDevice = async () => {
    setFormError(null)
    // The device factor reports a user-dismissed prompt as a thrown 'cancelled';
    // that is not a failure, so it never enters the chart's `failure` state.
    let dismissed = false
    const outcome = await verify.run('device', async () => {
      try {
        await unlockVaultWithDevice('Confirm it’s you')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (message !== 'cancelled') throw err
        dismissed = true
        return
      }
      if (!live.current) return
      playWalletSound('unlock')
      await onVerified(null)
    })
    if (!live.current) return
    if (dismissed) {
      if (canPassword) setPreferDevice(false)
      return
    }
    if (!outcome.ok && outcome.error !== null) {
      playWalletSound('error')
      if (canPassword) setPreferDevice(false)
    }
  }

  useEffect(() => {
    if (!preferDevice) return
    void verifyWithDevice()
    // Auto-prompt once when the gate opens with device preferred.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setFormError(null)
    if (!canPassword) {
      setFormError('No HandCash password on this wallet. Use device unlock.')
      playWalletSound('deny')
      return
    }
    if (password.length < UNLOCK_PASSWORD_MIN_LENGTH) {
      setFormError(`Password must be at least ${UNLOCK_PASSWORD_MIN_LENGTH} characters`)
      playWalletSound('deny')
      return
    }
    const outcome = await verify.run('password', async () => {
      await unlockVault(password)
      if (!live.current) return
      playWalletSound('unlock')
      await onVerified(password)
    })
    if (live.current && !outcome.ok && outcome.error !== null) playWalletSound('error')
  }

  const error = formError ?? verify.error
  const busy = verify.busy

  return (
    <div
      className="confirm-password-gate"
      data-aeon-scope="confirm-password"
      data-aeon-state={verify.stateAttr}
      data-factor={preferDevice && canDevice ? 'device' : 'password'}
    >
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
            onClick={() => void verifyWithDevice()}
          >
            {verify.running('device') ? 'Waiting…' : 'Use device unlock'}
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
              {verify.running('password') ? 'Checking…' : actionLabel}
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
