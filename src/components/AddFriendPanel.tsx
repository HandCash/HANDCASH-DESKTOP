import { useState, type FormEvent } from 'react'
import { addFriendFromRecipient } from '../wallet/friends'
import { clearNavChild, getNavState } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'

function initialFromNav(): { label: string; recipient: string } {
  const child = getNavState().child
  if (child?.type !== 'add-friend') return { label: '', recipient: '' }
  return {
    label: child.label?.trim() ?? '',
    recipient: child.identityKey?.trim() ?? '',
  }
}

export function AddFriendPanel() {
  const seeded = initialFromNav()
  const [label, setLabel] = useState(seeded.label)
  const [recipient, setRecipient] = useState(seeded.recipient)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onAdd = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      await addFriendFromRecipient({ label, recipient })
      playWalletSound('soft')
      toastSuccess('Friend added')
      clearNavChild()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      playWalletSound('error')
      toastError('Couldn’t add friend', message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="nav-child-panel add-friend-panel" data-aeon-scope="add-friend">
      <form className="friends-add-form" onSubmit={(e) => void onAdd(e)}>
        <div className="field">
          <label htmlFor="friend-label">Label</label>
          <input
            id="friend-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Alice (optional for $handles)"
            autoComplete="off"
            autoFocus
            disabled={busy}
          />
        </div>
        <div className="field">
          <label htmlFor="friend-key">Handle or identity key</label>
          <input
            id="friend-key"
            className="mono"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="$alice, peerpay:…, or 02… / 03…"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
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
            disabled={busy || !recipient.trim()}
          >
            {busy ? 'Adding…' : 'Add friend'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => clearNavChild()}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
