import { useState, type FormEvent } from 'react'
import { addFriend } from '../wallet/friends'
import { clearNavChild } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'

export function AddFriendPanel() {
  const [label, setLabel] = useState('')
  const [identityKey, setIdentityKey] = useState('')
  const [error, setError] = useState<string | null>(null)

  const onAdd = (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      addFriend({ label, identityKey })
      playWalletSound('soft')
      toastSuccess('Friend added')
      clearNavChild()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      playWalletSound('error')
      toastError('Couldn’t add friend', message)
    }
  }

  return (
    <div className="nav-child-panel add-friend-panel" data-aeon-scope="add-friend">
      <form className="friends-add-form" onSubmit={onAdd}>
        <div className="field">
          <label htmlFor="friend-label">Label</label>
          <input
            id="friend-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Alice"
            autoComplete="off"
            autoFocus
          />
        </div>
        <div className="field">
          <label htmlFor="friend-key">Identity key</label>
          <input
            id="friend-key"
            className="mono"
            value={identityKey}
            onChange={(e) => setIdentityKey(e.target.value)}
            placeholder="02… or 03… (66 hex chars)"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        {error && (
          <p className="error" role="status">
            {error}
          </p>
        )}
        <div className="actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!label.trim() || !identityKey.trim()}
          >
            Add friend
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => clearNavChild()}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
