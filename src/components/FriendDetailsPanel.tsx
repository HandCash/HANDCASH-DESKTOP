import { useEffect, useState, type FormEvent } from 'react'
import type { Chain } from '../wallet/vault'
import {
  addressFromIdentityKey,
  friendHasFixedHandle,
  getFriendById,
  removeFriend,
  subscribeFriends,
  updateFriend,
  type Friend,
} from '../wallet/friends'
import { clearNavChild, openMessagesWithFriend } from '../wallet/navStore'
import { copyText } from '../wallet/clipboard'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'

type Props = {
  friendId: string
  chain: Chain
}

export function FriendDetailsPanel({ friendId, chain }: Props) {
  const [friend, setFriend] = useState<Friend | null>(() => getFriendById(friendId))
  const [label, setLabel] = useState(friend?.label ?? '')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    return subscribeFriends(() => {
      const next = getFriendById(friendId)
      setFriend(next)
      if (next) setLabel(next.label)
    })
  }, [friendId])

  useEffect(() => {
    const next = getFriendById(friendId)
    setFriend(next)
    setLabel(next?.label ?? '')
    setError(null)
  }, [friendId])

  if (!friend) {
    return <p className="connected-empty-line">Friend not found</p>
  }

  let address = ''
  try {
    address = addressFromIdentityKey(friend.identityKey, chain)
  } catch {
    address = 'Invalid key'
  }

  const handleFixed = friendHasFixedHandle(friend)
  const displayHandle = (friend.handle?.trim() || friend.label).trim()

  const onSave = (e: FormEvent) => {
    e.preventDefault()
    if (handleFixed) return
    setError(null)
    try {
      updateFriend(friend.id, { label })
      playWalletSound('soft')
      toastSuccess('Friend saved')
    } catch (err) {
      playWalletSound('error')
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      toastError('Couldn’t save friend', message)
    }
  }

  const copyKey = async () => {
    await copyText(friend.identityKey, { label: 'identity key' })
  }

  const copyAddress = async () => {
    if (!address || address === 'Invalid key') return
    await copyText(address, { label: 'address' })
  }

  return (
    <div className="nav-child-panel friend-details" data-aeon-scope="friend-details">
      <form className="friends-add-form" onSubmit={onSave}>
        {handleFixed ? (
          <div className="field">
            <span className="field-static-label">Handle</span>
            <span className="wallet-detail-value">{displayHandle}</span>
          </div>
        ) : (
          <div className="field">
            <label htmlFor="friend-edit-label">Label</label>
            <input
              id="friend-edit-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Alice"
              autoComplete="off"
              autoFocus
            />
          </div>
        )}

        <div className="field">
          <span className="field-static-label">Identity key</span>
          <button
            type="button"
            className="mono wallet-detail-value friend-copy-value"
            title="Click to copy identity key"
            onClick={() => void copyKey()}
          >
            {friend.identityKey}
          </button>
        </div>

        <div className="field">
          <span className="field-static-label">Receive address</span>
          <button
            type="button"
            className="mono wallet-detail-value friend-copy-value"
            title="Click to copy address"
            onClick={() => void copyAddress()}
          >
            {address}
          </button>
        </div>

        {error ? (
          <p className="error" role="status">
            {error}
          </p>
        ) : null}

        <div className="actions friend-details-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              playWalletSound('soft')
              openMessagesWithFriend(friend.id)
            }}
          >
            Message
          </button>
          {handleFixed ? null : (
            <button
              type="submit"
              className="btn btn-ghost"
              disabled={!label.trim() || label.trim() === friend.label}
            >
              Save
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              playWalletSound('deny')
              removeFriend(friend.id)
              clearNavChild()
            }}
          >
            Remove
          </button>
        </div>
      </form>
    </div>
  )
}
