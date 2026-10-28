import { Button } from '@aeon-ui/react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  readVaultUnlockFactors,
  unlockVault,
  unlockVaultWithDevice,
} from '../wallet/vault'
import {
  getOpenUnlockSecret,
  hasMemorablePassword,
  isNoDeviceLock,
} from '../wallet/deviceLockPrefs'
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
   * Password is null when verification used device or open (no-password) unlock.
   */
  onVerified: (password: string | null) => void | Promise<void>
  /** Force password path (e.g. change/remove password). */
  requirePassword?: boolean
  onCancel?: () => void
}

/**
 * Re-auth before sensitive settings work.
 * Prefers device unlock when enrolled; falls back to HandCash password.
 * Open-unlock wallets (no password chosen) confirm via the held wrap secret —
 * never ask for a password the holder never set.
 * One exclusive verification (`device` | `password` | `open`) at a time.
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
  /** No memorable password — vault wrap exists only as the open secret. */
  const openUnlock = !requirePassword && isNoDeviceLock()
  const canDevice = !requirePassword && factors.device
  const canPassword = !requirePassword
    ? hasMemorablePassword()
    : factors.password && !openUnlock
  const [password, setPassword] = useState('')
  /** Synchronous policy failures; the async failure lives in the chart. */
  const [formError, setFormError] = useState<string | null>(null)
  const [preferDevice, setPreferDevice] = useState(canDevice)
  const verify = useAsyncAction<'device' | 'password' | 'open'>()
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

  const verifyWithOpen = async () => {
    setFormError(null)
    const secret = getOpenUnlockSecret()
    if (!secret) {
      setFormError('This wallet has no unlock factor to confirm.')
      playWalletSound('deny')
      return
    }
    const outcome = await verify.run('open', async () => {
      await unlockVault(secret)
      if (!live.current) return
      playWalletSound('unlock')
      await onVerified(null)
    })
    if (live.current && !outcome.ok && outcome.error !== null) playWalletSound('error')
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setFormError(null)
    if (openUnlock) {
      await verifyWithOpen()
      return
    }
    if (!canPassword) {
      setFormError(
        canDevice
          ? 'No HandCash password on this wallet. Use device unlock.'
          : 'No unlock factor on this wallet.',
      )
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
  const factorAttr =
    preferDevice && canDevice ? 'device' : openUnlock ? 'open' : 'password'

  return (
    <div
      className="confirm-password-gate"
      data-aeon-scope="confirm-password"
      data-aeon-state={verify.stateAttr}
      data-factor={factorAttr}
    >
      <div className="confirm-password-copy">
        <h3 className="confirm-password-title">{title}</h3>
        <p className="confirm-password-lede">{lede}</p>
      </div>

      {openUnlock && !(preferDevice && canDevice) ? (
        <div className="actions">
          <Button.Root
            variant="solid"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void verifyWithOpen()}
          >
            <Button.Label>{verify.running('open') ? 'Checking…' : actionLabel}</Button.Label>
          </Button.Root>
          {canDevice ? (
            <Button.Root
              variant="ghost"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => setPreferDevice(true)}
            >
              <Button.Label>Use device unlock</Button.Label>
            </Button.Root>
          ) : null}
          {onCancel ? (
            <Button.Root variant="ghost" className="btn btn-ghost" disabled={busy} onClick={onCancel}>
              <Button.Label>Cancel</Button.Label>
            </Button.Root>
          ) : null}
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : preferDevice && canDevice ? (
        <div className="actions">
          <Button.Root variant="solid"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void verifyWithDevice()}
          >
            <Button.Label>{verify.running('device') ? 'Waiting…' : 'Use device unlock'}</Button.Label>
          </Button.Root>
          {canPassword ? (
            <Button.Root variant="ghost"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => setPreferDevice(false)}
            >
              <Button.Label>Use HandCash password</Button.Label>
            </Button.Root>
          ) : openUnlock ? (
            <Button.Root
              variant="ghost"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => setPreferDevice(false)}
            >
              <Button.Label>Continue without password</Button.Label>
            </Button.Root>
          ) : null}
          {onCancel ? (
            <Button.Root variant="ghost" className="btn btn-ghost" disabled={busy} onClick={onCancel}>
              <Button.Label>Cancel</Button.Label>
            </Button.Root>
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
            <Button.Root variant="solid"
              type="submit"
              className="btn btn-primary"
              disabled={busy || !canPassword || password.length < UNLOCK_PASSWORD_MIN_LENGTH}
            >
              <Button.Label>{verify.running('password') ? 'Checking…' : actionLabel}</Button.Label>
            </Button.Root>
            {canDevice && !requirePassword ? (
              <Button.Root variant="ghost"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => setPreferDevice(true)}
              >
                <Button.Label>Use device unlock</Button.Label>
              </Button.Root>
            ) : null}
            {onCancel ? (
              <Button.Root variant="ghost" className="btn btn-ghost" disabled={busy} onClick={onCancel}>
                <Button.Label>Cancel</Button.Label>
              </Button.Root>
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
