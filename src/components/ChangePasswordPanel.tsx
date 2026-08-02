import { useState, type FormEvent } from 'react'
import { clearDeviceAuth, enrollDeviceAuth, getDeviceAuthStatus } from '../wallet/deviceAuth'
import { changeVaultPassword } from '../wallet/vault'
import { validatePassword } from '../wallet/passwordPolicy'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'

export function ChangePasswordPanel() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)

    if (newPassword !== confirmPassword) {
      setError('New passwords do not match')
      return
    }
    const pwError = validatePassword(newPassword)
    if (pwError) {
      setError(pwError)
      return
    }

    setSubmitting(true)
    try {
      await changeVaultPassword(currentPassword, newPassword)
      // Old device-unlock secret is the previous password — replace if still enrolled.
      const status = await getDeviceAuthStatus()
      if (status.enrolled) {
        await clearDeviceAuth()
        if (status.available) {
          const enrolled = await enrollDeviceAuth(newPassword)
          if (enrolled.ok) {
            toastSuccess('Password updated', `${status.label} re-enabled`)
          } else {
            toastSuccess(
              'Password updated',
              `${status.label} cleared — unlock with password once to re-enable`,
            )
          }
        } else {
          toastSuccess('Password updated', `${status.label} cleared`)
        }
      } else {
        toastSuccess('Password updated')
      }
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      playWalletSound('success')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      playWalletSound('error')
      toastError('Couldn’t change password', message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="settings-detail settings-detail-compact settings-scroll" data-aeon-scope="settings-change-password">
      <form className="settings-form settings-form-compact" onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label htmlFor="settings-current-password">Current</label>
          <input
            id="settings-current-password"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            disabled={submitting}
          />
        </div>
        <div className="field">
          <label htmlFor="settings-new-password">New</label>
          <input
            id="settings-new-password"
            type="password"
            placeholder="10+ chars, letter and number"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            disabled={submitting}
          />
        </div>
        <div className="field">
          <label htmlFor="settings-confirm-password">Confirm</label>
          <input
            id="settings-confirm-password"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            disabled={submitting}
          />
        </div>

        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={
              submitting ||
              !currentPassword ||
              !newPassword ||
              !confirmPassword
            }
          >
            {submitting ? 'Updating…' : 'Change password'}
          </button>
        </div>
      </form>
    </div>
  )
}
