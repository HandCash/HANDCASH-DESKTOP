import { useEffect, useState } from 'react'
import { deviceAuthStatus, type DeviceAuthStatus } from '../wallet/deviceAuth'
import { applyOnboardLock } from '../wallet/applyOnboardLock'
import { type DeviceLockMode } from '../wallet/deviceLockPrefs'
import { playWalletSound } from '../wallet/soundService'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { PasswordField } from './PasswordField'

type Props = {
  wrapPassword: string
  onDone: (sessionPassword: string | null) => void
}

const OPTIONS: {
  id: DeviceLockMode
  title: string
  description: string
  needsDevice: boolean
}[] = [
  {
    id: 'none',
    title: 'None',
    description: 'Open this wallet on this computer without a prompt.',
    needsDevice: false,
  },
  {
    id: 'password',
    title: 'Password',
    description: 'Unlock with a HandCash password you choose.',
    needsDevice: false,
  },
  {
    id: 'device',
    title: 'Touch ID',
    description: 'Unlock with this device’s fingerprint or lock screen.',
    needsDevice: true,
  },
  {
    id: 'both',
    title: 'Password + Touch ID',
    description: 'Either your password or this device can unlock.',
    needsDevice: true,
  },
]

export function OnboardProtectPanel({ wrapPassword, onDone }: Props) {
  const [device, setDevice] = useState<DeviceAuthStatus | null>(null)
  const [mode, setMode] = useState<DeviceLockMode>('none')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  /** Synchronous choice/policy failures; the async failure lives in the chart. */
  const [formError, setFormError] = useState<string | null>(null)
  const save = useAsyncAction<'save'>()

  useEffect(() => {
    let cancelled = false
    void deviceAuthStatus().then((status) => {
      if (cancelled) return
      setDevice(status)
      if (status.available) setMode('device')
    })
    return () => {
      cancelled = true
    }
  }, [])

  const deviceAvailable = Boolean(device?.available)
  const deviceLabel = device?.label ?? 'Touch ID'
  const needsPassword = mode === 'password' || mode === 'both'

  const apply = async () => {
    setFormError(null)
    if ((mode === 'device' || mode === 'both') && !deviceAvailable) {
      setFormError(`${deviceLabel} is not available on this device`)
      return
    }
    if (needsPassword && password !== confirm) {
      setFormError('Passwords do not match')
      return
    }
    let sessionPassword: string | null = null
    const outcome = await save.run('save', async () => {
      const result = await applyOnboardLock({
        wrapPassword,
        mode,
        userPassword: needsPassword ? password : undefined,
      })
      sessionPassword = result.sessionPassword
    })
    if (outcome.ok) {
      playWalletSound('success')
      onDone(sessionPassword)
    } else if (outcome.error) {
      playWalletSound('error')
    }
  }

  const error = formError ?? save.error

  return (
    <div className="wallet-setup-config" data-aeon-scope="onboard-protect">
      <h2>Protect this device</h2>
      <p className="auth-lede">
        Choose how HandCash unlocks on this computer. You can change this later in Settings.
      </p>

      <div className="wallet-setup-options" role="radiogroup" aria-label="Device lock">
        {OPTIONS.map((opt) => {
          const disabled = opt.needsDevice && !deviceAvailable
          const active = mode === opt.id
          const title = opt.id === 'device' || opt.id === 'both'
            ? opt.title.replace('Touch ID', deviceLabel)
            : opt.title
          return (
            <label
              key={opt.id}
              className={[
                'wallet-setup-option',
                active ? 'is-selected' : '',
                disabled ? 'is-disabled' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <input
                type="radio"
                name="onboard-lock"
                value={opt.id}
                checked={active}
                disabled={disabled}
                onChange={() => {
                  if (!disabled) setMode(opt.id)
                }}
              />
              <span className="wallet-setup-option-body">
                <strong>{title}</strong>
                <span>
                  {disabled
                    ? `${deviceLabel} is not available on this device`
                    : opt.description}
                </span>
              </span>
            </label>
          )
        })}
      </div>

      {needsPassword ? (
        <div className="auth-form" style={{ marginTop: 8 }}>
          <PasswordField
            id="onboard-lock-password"
            label="HandCash password"
            placeholder="10+ chars, letter and number"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            autoFocus
          />
          <p className="password-hint">This password unlocks the wallet on this device. Don’t forget it.</p>
          <PasswordField
            id="onboard-lock-password-confirm"
            label="Confirm password"
            placeholder="Type it again"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
        </div>
      ) : null}

      {error ? (
        <p className="error auth-error" role="alert">
          {error}
        </p>
      ) : null}

      <div
        className="auth-actions"
        style={{ marginTop: 16 }}
        data-aeon-part="onboard-protect-actions"
        data-aeon-state={save.stateAttr}
      >
        <button
          type="button"
          className="btn btn-primary auth-submit"
          disabled={save.busy}
          onClick={() => void apply()}
        >
          {save.busy ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </div>
  )
}
