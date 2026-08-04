import { useState, type FormEvent } from 'react'
import { unlockVault } from '../wallet/vault'
import { UNLOCK_PASSWORD_MIN_LENGTH } from '../wallet/passwordPolicy'
import { playWalletSound } from '../wallet/soundService'

type Props = {
  title: string
  lede: string
  /** Primary button while locked. */
  actionLabel?: string
  /** Accessible id for the password field. */
  id?: string
  /** Called after the unlock password verifies. */
  onVerified: (password: string) => void | Promise<void>
}

/**
 * Standard re-auth before sensitive settings work.
 * Verifies the vault unlock password, then hands it to the caller.
 */
export function ConfirmPasswordGate({
  title,
  lede,
  actionLabel = 'Continue',
  id = 'confirm-password',
  onVerified,
}: Props) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
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
      <form className="settings-form settings-form-compact" onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label htmlFor={id}>Unlock password</label>
          <input
            id={id}
            type="password"
            autoComplete="current-password"
            placeholder="Your unlock password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            disabled={busy}
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
            disabled={busy || password.length < UNLOCK_PASSWORD_MIN_LENGTH}
          >
            {busy ? 'Checking…' : actionLabel}
          </button>
        </div>
      </form>
    </div>
  )
}
