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
import { CopyIcon, MessagesIcon } from './icons'

type Props = {
  friendId: string
  chain: Chain
}

export function FriendDetailsPanel({ friendId, chain }: Props) {
  const [friend, setFriend] = useState<Friend | null>(() => getFriendById(friendId))
  const [label, setLabel] = useState(friend?.label ?? '')
  const [error, setError] = useState<string | null>(null)
  const [confirmingRemove, setConfirmingRemove] = useState(false)

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
    setConfirmingRemove(false)
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

  const onRemove = () => {
    playWalletSound('deny')
    removeFriend(friend.id)
    clearNavChild()
  }

  return (
    <div className="nav-child-panel friend-details" data-aeon-scope="friend-details">
      <form className="friends-add-form" onSubmit={onSave}>
        <section className="friend-details-overview" aria-labelledby="friend-overview-name">
          <span className="friend-avatar friend-avatar-lg" aria-hidden>
            {displayHandle.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <h3 id="friend-overview-name">{displayHandle}</h3>
            {handleFixed ? <p>Handle contact</p> : null}
          </div>
        </section>

        {handleFixed ? (
          <p className="friend-fixed-note">Handle names are managed by their owner.</p>
        ) : (
          <div className="field">
            <label htmlFor="friend-edit-label">Contact name</label>
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

        <div className="friend-copy-row">
          <div>
            <span className="field-static-label">Identity key</span>
            <span className="mono wallet-detail-value" title={friend.identityKey}>
              {friend.identityKey}
            </span>
          </div>
          <button
            type="button"
            className="friend-copy-action"
            aria-label="Copy identity key"
            onClick={() => void copyKey()}
          >
            <CopyIcon size={16} />
            Copy
          </button>
        </div>

        <div className="friend-copy-row">
          <div>
            <span className="field-static-label">Receive address</span>
            <span className="mono wallet-detail-value" title={address}>
              {address}
            </span>
          </div>
          <button
            type="button"
            className="friend-copy-action"
            aria-label="Copy receive address"
            onClick={() => void copyAddress()}
            disabled={address === 'Invalid key'}
          >
            <CopyIcon size={16} />
            Copy
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
            <MessagesIcon size={16} />
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
          {confirmingRemove ? (
            <span className="friend-remove-confirm" role="group" aria-label="Confirm removal">
              <span>Remove contact?</span>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setConfirmingRemove(false)}
              >
                Keep
              </button>
              <button type="button" className="btn btn-danger" onClick={onRemove}>
                Remove
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="btn btn-danger friend-remove-btn"
              onClick={() => setConfirmingRemove(true)}
            >
              Remove
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
