import { useState, type FormEvent } from 'react'
import { changeVaultPassword } from '../wallet/vault'
import { playWalletSound } from '../wallet/soundService'

export function ChangePasswordPanel() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(false)

    if (newPassword !== confirmPassword) {
      setError('New passwords do not match')
      return
    }
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    setSubmitting(true)
    try {
      await changeVaultPassword(currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setSuccess(true)
      playWalletSound('success')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      playWalletSound('error')
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
            placeholder="At least 8 characters"
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
        {success ? (
          <p className="settings-success" role="status">
            Password updated.
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
