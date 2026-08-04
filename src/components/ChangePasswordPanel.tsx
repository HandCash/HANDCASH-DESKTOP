import { useState, type FormEvent } from 'react'
import { changeVaultPassword } from '../wallet/vault'
import { validatePassword } from '../wallet/passwordPolicy'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { ConfirmPasswordGate } from './ConfirmPasswordGate'
import { PasswordField } from './PasswordField'

export function ChangePasswordPanel() {
  const [currentPassword, setCurrentPassword] = useState<string | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!currentPassword) return
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

    setSubmitting(true)
    try {
      await changeVaultPassword(currentPassword, newPassword)
      setCurrentPassword(null)
      setNewPassword('')
      setConfirmPassword('')
      playWalletSound('success')
      toastSuccess('Password updated')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      playWalletSound('error')
      toastError('Couldn’t change password', message)
    } finally {
      setSubmitting(false)
    }
  }

  if (!currentPassword) {
    return (
      <div
        className="settings-detail settings-detail-compact settings-scroll"
        data-aeon-scope="settings-change-password"
      >
        <ConfirmPasswordGate
          id="settings-current-password"
          title="Change password"
          lede="Confirm your current unlock password, then choose a new one."
          actionLabel="Continue"
          onVerified={(password) => setCurrentPassword(password)}
        />
      </div>
    )
  }

  return (
    <div
      className="settings-detail settings-detail-compact settings-scroll"
      data-aeon-scope="settings-change-password"
      data-aeon-state="new"
    >
      <div className="confirm-password-copy">
        <h3 className="confirm-password-title">Choose a new password</h3>
        <p className="confirm-password-lede">
          This password is used to access your wallet. Don’t forget it.
        </p>
      </div>
      <form className="settings-form settings-form-compact" onSubmit={(e) => void submit(e)}>
        <PasswordField
          id="settings-new-password"
          label="New password"
          placeholder="10+ chars, letter and number"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
          autoFocus
          disabled={submitting}
        />
        <PasswordField
          id="settings-confirm-password"
          label="Confirm password"
          placeholder="Type it again"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
          disabled={submitting}
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
            disabled={submitting || !newPassword || !confirmPassword}
          >
            {submitting ? 'Updating…' : 'Update password'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={submitting}
            onClick={() => {
              setCurrentPassword(null)
              setNewPassword('')
              setConfirmPassword('')
              setError(null)
              playWalletSound('soft')
            }}
          >
            Back
          </button>
        </div>
      </form>
    </div>
  )
}
