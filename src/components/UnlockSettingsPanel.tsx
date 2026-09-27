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
import {
  clearOpenUnlockSecret,
  getOpenUnlockSecret,
  isNoDeviceLock,
  setDeviceLockMode,
} from '../wallet/deviceLockPrefs'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { ConfirmPasswordGate } from './ConfirmPasswordGate'
import { PasswordField } from './PasswordField'

type Mode =
  | 'overview'
  | 'change-password'
  | 'set-password'
  | 'enable-device'
  | 'disable-password'
  | 'disable-device'

type FactorMutation =
  | 'changePassword'
  | 'setPassword'
  | 'enableDevice'
  | 'disablePassword'
  | 'disableDevice'

/**
 * Settings → Unlock: manage HandCash password vs device lock independently.
 */
export function UnlockSettingsPanel() {
  const [factors, setFactors] = useState<VaultUnlockFactors>(() => readVaultUnlockFactors())
  const [device, setDevice] = useState<DeviceAuthStatus | null>(null)
  const [mode, setMode] = useState<Mode>('overview')
  /** Synchronous policy failures; the async failure lives in the chart. */
  const [formError, setFormError] = useState<string | null>(null)
  /** One exclusive factor mutation at a time. */
  const mutation = useAsyncAction<FactorMutation>()
  const busy = mutation.busy
  const error = formError ?? mutation.error
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
    setFormError(null)
    mutation.reset()
    setMode('overview')
  }

  /**
   * Run one factor mutation through the chart. A dismissed device prompt
   * (thrown 'cancelled') is not a failure and never enters `failure`.
   */
  const runFactor = async (
    kind: FactorMutation,
    copy: { success: string; failure: string },
    task: () => Promise<void>,
  ) => {
    setFormError(null)
    let dismissed = false
    const outcome = await mutation.run(kind, async () => {
      try {
        await task()
      } catch (err) {
        if (err instanceof Error && err.message === 'cancelled') {
          dismissed = true
          return
        }
        throw err
      }
    })
    if (dismissed) return
    if (outcome.ok) {
      playWalletSound('success')
      toastSuccess(copy.success)
      resetForm()
      await refresh()
    } else if (outcome.error !== null) {
      playWalletSound('error')
      toastError(copy.failure, outcome.error)
    }
  }

  const validateNewPassword = (): boolean => {
    setFormError(null)
    if (newPassword !== confirmPassword) {
      setFormError('Passwords do not match')
      return false
    }
    const pwError = validatePassword(newPassword)
    if (pwError) {
      setFormError(pwError)
      return false
    }
    return true
  }

  const runChangePassword = async (e: FormEvent) => {
    e.preventDefault()
    if (!gatePassword || !validateNewPassword()) return
    await runFactor(
      'changePassword',
      { success: 'Password updated', failure: 'Couldn’t change password' },
      () => changeVaultPassword(gatePassword, newPassword),
    )
  }

  const runSetPassword = async (e: FormEvent) => {
    e.preventDefault()
    if (!validateNewPassword()) return
    await runFactor(
      'setPassword',
      { success: 'HandCash password added', failure: 'Couldn’t set password' },
      async () => {
        const openSecret = getOpenUnlockSecret()
        if (openSecret) {
          await changeVaultPassword(openSecret, newPassword)
          clearOpenUnlockSecret()
          setDeviceLockMode('password')
        } else {
          await setVaultPasswordFromDevice(newPassword)
          setDeviceLockMode(readVaultUnlockFactors().device ? 'both' : 'password')
        }
      },
    )
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
        <form
          className="settings-form settings-form-compact"
          data-aeon-part="factor-form"
          data-aeon-state={mutation.stateAttr}
          onSubmit={(e) => void runChangePassword(e)}
        >
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
        <form
          className="settings-form settings-form-compact"
          data-aeon-part="factor-form"
          data-aeon-state={mutation.stateAttr}
          onSubmit={(e) => void runSetPassword(e)}
        >
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

  if (mode === 'enable-device' && isNoDeviceLock()) {
    return (
      <div className="settings-detail settings-detail-compact settings-scroll" data-aeon-scope="settings-unlock">
        <div className="confirm-password-copy">
          <h3 className="confirm-password-title">Turn on device unlock</h3>
          <p className="confirm-password-lede">
            Seal unlock with {device?.label ?? 'this device'}. You can add a HandCash password later.
          </p>
        </div>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="actions" data-aeon-part="factor-form" data-aeon-state={mutation.stateAttr}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => {
              const openSecret = getOpenUnlockSecret()
              if (!openSecret) return
              void runFactor(
                'enableDevice',
                { success: 'Device unlock on', failure: 'Couldn’t enable device unlock' },
                async () => {
                  await enableDeviceUnlock(openSecret)
                  clearOpenUnlockSecret()
                  setDeviceLockMode('device')
                },
              )
            }}
          >
            {busy ? 'Saving…' : 'Enable'}
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={resetForm}>
            Back
          </button>
        </div>
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
            const openSecret = getOpenUnlockSecret()
            const used = password || openSecret
            if (!used) return
            await runFactor(
              'enableDevice',
              { success: 'Device unlock on', failure: 'Couldn’t enable device unlock' },
              async () => {
                await enableDeviceUnlock(used)
                if (openSecret && used === openSecret) {
                  clearOpenUnlockSecret()
                  setDeviceLockMode('device')
                } else {
                  setDeviceLockMode('both')
                }
              },
            )
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
            await runFactor(
              'disablePassword',
              { success: 'HandCash password removed', failure: 'Couldn’t remove password' },
              () => disableVaultPassword(password),
            )
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
            await runFactor(
              'disableDevice',
              { success: 'Device unlock off', failure: 'Couldn’t turn off device unlock' },
              () => disableDeviceUnlock(password),
            )
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
          {isNoDeviceLock()
            ? 'This device opens the wallet without a prompt. Add a password or Touch ID any time.'
            : 'Use this device’s fingerprint or lock screen, a HandCash password, or both. Keep at least one.'}
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
                disabled={!factors.password && !isNoDeviceLock()}
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
              {isNoDeviceLock()
                ? 'Off · no prompt on this device'
                : factors.password
                  ? 'On · separate from device lock'
                  : 'Off'}
            </span>
          </div>
          {isNoDeviceLock() ? (
            <button type="button" className="btn btn-primary" onClick={() => setMode('set-password')}>
              Add
            </button>
          ) : factors.password ? (
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
