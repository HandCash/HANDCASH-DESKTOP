import { useState, type FormEvent } from 'react'
import { changeVaultPassword } from '../wallet/vault'
import { validatePassword } from '../wallet/passwordPolicy'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { ConfirmPasswordGate } from './ConfirmPasswordGate'
import { PasswordField } from './PasswordField'

export function ChangePasswordPanel() {
  const [currentPassword, setCurrentPassword] = useState<string | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  /** Synchronous policy failures; the async failure lives in the chart. */
  const [formError, setFormError] = useState<string | null>(null)
  const change = useAsyncAction<'change'>()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!currentPassword) return
    setFormError(null)

    if (newPassword !== confirmPassword) {
      setFormError('Passwords do not match')
      return
    }
    const pwError = validatePassword(newPassword)
    if (pwError) {
      setFormError(pwError)
      return
    }

    const outcome = await change.run('change', async () => {
      await changeVaultPassword(currentPassword, newPassword)
    })
    if (outcome.ok) {
      setCurrentPassword(null)
      setNewPassword('')
      setConfirmPassword('')
      playWalletSound('success')
      toastSuccess('Password updated')
    } else if (outcome.error) {
      playWalletSound('error')
      toastError('Couldn’t change password', outcome.error)
    }
  }

  const error = formError ?? change.error

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
      <form
        className="settings-form settings-form-compact"
        data-aeon-part="change-password-form"
        data-aeon-state={change.stateAttr}
        onSubmit={(e) => void submit(e)}
      >
        <PasswordField
          id="settings-new-password"
          label="New password"
          placeholder="10+ chars, letter and number"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
          autoFocus
          disabled={change.busy}
        />
        <PasswordField
          id="settings-confirm-password"
          label="Confirm password"
          placeholder="Type it again"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
          disabled={change.busy}
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
            disabled={change.busy || !newPassword || !confirmPassword}
          >
            {change.busy ? 'Updating…' : 'Update password'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={change.busy}
            onClick={() => {
              setCurrentPassword(null)
              setNewPassword('')
              setConfirmPassword('')
              setFormError(null)
              change.reset()
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
