import { useEffect, useState, type FormEvent } from 'react'
import {
  deviceAuthStatus,
  type DeviceAuthStatus,
} from '../wallet/deviceAuth'
import {
  changeVaultPassword,
  disableDeviceUnlock,
  disableVaultPassword,
  enableDeviceUnlock,
  readVaultUnlockFactors,
  setVaultPasswordFromDevice,
  type VaultUnlockFactors,
} from '../wallet/vault'
import { validatePassword } from '../wallet/passwordPolicy'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { ConfirmPasswordGate } from './ConfirmPasswordGate'
import { PasswordField } from './PasswordField'

type Mode =
  | 'overview'
  | 'change-password'
  | 'set-password'
  | 'enable-device'
  | 'disable-password'
  | 'disable-device'

/**
 * Settings → Unlock: manage HandCash password vs device lock independently.
 */
export function UnlockSettingsPanel() {
  const [factors, setFactors] = useState<VaultUnlockFactors>(() => readVaultUnlockFactors())
  const [device, setDevice] = useState<DeviceAuthStatus | null>(null)
  const [mode, setMode] = useState<Mode>('overview')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [gatePassword, setGatePassword] = useState<string | null>(null)

  const refresh = async () => {
    setFactors(readVaultUnlockFactors())
    setDevice(await deviceAuthStatus())
  }

  useEffect(() => {
    void refresh()
  }, [])

  const resetForm = () => {
    setNewPassword('')
    setConfirmPassword('')
    setGatePassword(null)
    setError(null)
    setMode('overview')
  }

  const runChangePassword = async (e: FormEvent) => {
    e.preventDefault()
    if (!gatePassword) return
    setError(null)
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    const pwError = validatePassword(newPassword)
    if (pwError) {
      setError(pwError)
      return
    }
    setBusy(true)
    try {
      await changeVaultPassword(gatePassword, newPassword)
      playWalletSound('success')
      toastSuccess('Password updated')
      resetForm()
      await refresh()
    } catch (err) {
      playWalletSound('error')
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      toastError('Couldn’t change password', message)
    } finally {
      setBusy(false)
    }
  }

  const runSetPassword = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    const pwError = validatePassword(newPassword)
    if (pwError) {
      setError(pwError)
      return
    }
    setBusy(true)
    try {
      await setVaultPasswordFromDevice(newPassword)
      playWalletSound('success')
      toastSuccess('HandCash password added')
      resetForm()
      await refresh()
    } catch (err) {
      playWalletSound('error')
      const message = err instanceof Error ? err.message : String(err)
      if (message !== 'cancelled') {
        setError(message)
        toastError('Couldn’t set password', message)
      }
    } finally {
      setBusy(false)
    }
  }

  if (mode === 'change-password' && !gatePassword) {
    return (
      <div className="settings-detail settings-detail-compact settings-scroll" data-aeon-scope="settings-unlock">
        <ConfirmPasswordGate
          id="unlock-change-password"
          title="Change password"
          lede="Confirm your current HandCash password, then choose a new one."
          requirePassword
          onVerified={(password) => setGatePassword(password ?? '')}
          onCancel={resetForm}
        />
      </div>
    )
  }

  if (mode === 'change-password' && gatePassword) {
    return (
      <div
        className="settings-detail settings-detail-compact settings-scroll"
        data-aeon-scope="settings-unlock"
        data-aeon-state="change-password"
      >
        <div className="confirm-password-copy">
          <h3 className="confirm-password-title">Choose a new password</h3>
          <p className="confirm-password-lede">
            This HandCash password is separate from your phone or computer unlock.
          </p>
        </div>
        <form className="settings-form settings-form-compact" onSubmit={(e) => void runChangePassword(e)}>
          <PasswordField
            id="settings-new-password"
            label="New password"
            placeholder="10+ chars, letter and number"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            autoFocus
            disabled={busy}
          />
          <PasswordField
            id="settings-confirm-password"
            label="Confirm password"
            placeholder="Type it again"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            disabled={busy}
          />
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={busy || !newPassword}>
              {busy ? 'Updating…' : 'Update password'}
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={resetForm}>
              Back
            </button>
          </div>
        </form>
      </div>
    )
  }

  if (mode === 'set-password') {
    return (
      <div
        className="settings-detail settings-detail-compact settings-scroll"
        data-aeon-scope="settings-unlock"
        data-aeon-state="set-password"
      >
        <div className="confirm-password-copy">
          <h3 className="confirm-password-title">Add a HandCash password</h3>
          <p className="confirm-password-lede">
            Optional backup unlock when biometrics aren’t available. Confirm with this device first.
          </p>
        </div>
        <form className="settings-form settings-form-compact" onSubmit={(e) => void runSetPassword(e)}>
          <PasswordField
            id="settings-set-password"
            label="HandCash password"
            placeholder="10+ chars, letter and number"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            autoFocus
            disabled={busy}
          />
          <PasswordField
            id="settings-set-password-confirm"
            label="Confirm password"
            placeholder="Type it again"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            disabled={busy}
          />
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={busy || !newPassword}>
              {busy ? 'Saving…' : 'Save password'}
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={resetForm}>
              Back
            </button>
          </div>
        </form>
      </div>
    )
  }

  if (mode === 'enable-device') {
    return (
      <div className="settings-detail settings-detail-compact settings-scroll" data-aeon-scope="settings-unlock">
        <ConfirmPasswordGate
          id="unlock-enable-device"
          title="Turn on device unlock"
          lede={`Confirm your HandCash password, then seal unlock with ${device?.label ?? 'this device'}.`}
          requirePassword
          actionLabel="Enable"
          onVerified={async (password) => {
            if (!password) return
            setBusy(true)
            try {
              await enableDeviceUnlock(password)
              playWalletSound('success')
              toastSuccess('Device unlock on')
              resetForm()
              await refresh()
            } catch (err) {
              playWalletSound('error')
              const message = err instanceof Error ? err.message : String(err)
              toastError('Couldn’t enable device unlock', message)
              setError(message)
            } finally {
              setBusy(false)
            }
          }}
          onCancel={resetForm}
        />
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    )
  }

  if (mode === 'disable-password') {
    return (
      <div className="settings-detail settings-detail-compact settings-scroll" data-aeon-scope="settings-unlock">
        <ConfirmPasswordGate
          id="unlock-disable-password"
          title="Remove HandCash password"
          lede="You’ll unlock with this device only. Save phrase or slices first — then confirm your HandCash password to remove it."
          requirePassword
          actionLabel="Remove password"
          onVerified={async (password) => {
            if (!password) return
            try {
              await disableVaultPassword(password)
              playWalletSound('success')
              toastSuccess('HandCash password removed')
              resetForm()
              await refresh()
            } catch (err) {
              playWalletSound('error')
              const message = err instanceof Error ? err.message : String(err)
              toastError('Couldn’t remove password', message)
            }
          }}
          onCancel={resetForm}
        />
      </div>
    )
  }

  if (mode === 'disable-device') {
    return (
      <div className="settings-detail settings-detail-compact settings-scroll" data-aeon-scope="settings-unlock">
        <ConfirmPasswordGate
          id="unlock-disable-device"
          title="Turn off device unlock"
          lede="You’ll unlock with your HandCash password only."
          requirePassword
          actionLabel="Turn off"
          onVerified={async (password) => {
            if (!password) return
            try {
              await disableDeviceUnlock(password)
              playWalletSound('success')
              toastSuccess('Device unlock off')
              resetForm()
              await refresh()
            } catch (err) {
              playWalletSound('error')
              const message = err instanceof Error ? err.message : String(err)
              toastError('Couldn’t turn off device unlock', message)
            }
          }}
          onCancel={resetForm}
        />
      </div>
    )
  }

  const deviceLabel = device?.label ?? 'Device unlock'
  const deviceAvailable = Boolean(device?.available)

  return (
    <div
      className="settings-detail settings-detail-compact settings-scroll"
      data-aeon-scope="settings-unlock"
      data-aeon-state="overview"
    >
      <div className="confirm-password-copy">
        <h3 className="confirm-password-title">Unlock</h3>
        <p className="confirm-password-lede">
          Use this device’s fingerprint or lock screen, a HandCash password, or both. Keep at least one.
        </p>
      </div>

      <ul className="settings-list">
        <li className="settings-row settings-row-static">
          <div className="settings-row-copy">
            <span className="settings-row-label">{deviceLabel}</span>
            <span className="settings-row-description">
              {!deviceAvailable
                ? 'Not available on this device'
                : factors.device
                  ? device?.strongBox
                    ? 'On · hardware sealed'
                    : 'On'
                  : 'Off'}
            </span>
          </div>
          {deviceAvailable ? (
            factors.device ? (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!factors.password}
                onClick={() => setMode('disable-device')}
              >
                Turn off
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!factors.password}
                onClick={() => setMode('enable-device')}
              >
                Turn on
              </button>
            )
          ) : null}
        </li>
        <li className="settings-row settings-row-static">
          <div className="settings-row-copy">
            <span className="settings-row-label">HandCash password</span>
            <span className="settings-row-description">
              {factors.password ? 'On · separate from device lock' : 'Off'}
            </span>
          </div>
          {factors.password ? (
            <div className="actions" style={{ gap: 8 }}>
              <button type="button" className="btn btn-ghost" onClick={() => setMode('change-password')}>
                Change
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!factors.device}
                onClick={() => setMode('disable-password')}
              >
                Remove
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!factors.device}
              onClick={() => setMode('set-password')}
            >
              Add
            </button>
          )}
        </li>
      </ul>
    </div>
  )
}
