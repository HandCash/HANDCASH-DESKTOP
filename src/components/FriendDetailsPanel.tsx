import { useEffect, useState, type FormEvent } from 'react'
import type { Chain } from '../wallet/vault'
import {
  addressFromIdentityKey,
  getFriendById,
  removeFriend,
  subscribeFriends,
  updateFriend,
  type Friend,
} from '../wallet/friends'
import { clearNavChild } from '../wallet/navStore'
import { copyText } from '../wallet/clipboard'
import { playWalletSound } from '../wallet/soundService'

type Props = {
  friendId: string
  chain: Chain
}

export function FriendDetailsPanel({ friendId, chain }: Props) {
  const [friend, setFriend] = useState<Friend | null>(() => getFriendById(friendId))
  const [label, setLabel] = useState(friend?.label ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [copiedKey, setCopiedKey] = useState(false)
  const [copiedAddress, setCopiedAddress] = useState(false)

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
    setSaved(false)
    setCopiedKey(false)
    setCopiedAddress(false)
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

  const onSave = (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setSaved(false)
    try {
      updateFriend(friend.id, { label })
      setSaved(true)
      playWalletSound('soft')
    } catch (err) {
      playWalletSound('error')
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const copyKey = async () => {
    if (await copyText(friend.identityKey)) {
      setCopiedKey(true)
      setCopiedAddress(false)
      window.setTimeout(() => setCopiedKey(false), 1600)
    }
  }

  const copyAddress = async () => {
    if (!address || address === 'Invalid key') return
    if (await copyText(address)) {
      setCopiedAddress(true)
      setCopiedKey(false)
      window.setTimeout(() => setCopiedAddress(false), 1600)
    }
  }

  return (
    <div className="nav-child-panel friend-details" data-aeon-scope="friend-details">
      <form className="friends-add-form" onSubmit={onSave}>
        <div className="field">
          <label htmlFor="friend-edit-label">Label</label>
          <input
            id="friend-edit-label"
            value={label}
            onChange={(e) => {
              setLabel(e.target.value)
              setSaved(false)
            }}
            placeholder="Alice"
            autoComplete="off"
            autoFocus
          />
        </div>

        <div className="field">
          <span className="field-static-label">Identity key</span>
          <button
            type="button"
            className={`mono wallet-detail-value friend-copy-value${copiedKey ? ' is-copied' : ''}`}
            title="Click to copy identity key"
            onClick={() => void copyKey()}
          >
            {copiedKey ? 'Copied' : friend.identityKey}
          </button>
        </div>

        <div className="field">
          <span className="field-static-label">Receive address</span>
          <button
            type="button"
            className={`mono wallet-detail-value friend-copy-value${copiedAddress ? ' is-copied' : ''}`}
            title="Click to copy address"
            onClick={() => void copyAddress()}
          >
            {copiedAddress ? 'Copied' : address}
          </button>
        </div>

        {error ? (
          <p className="error" role="status">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p className="friend-saved" role="status">
            Saved
          </p>
        ) : null}

        <div className="actions friend-details-actions">
          <button type="submit" className="btn btn-ghost" disabled={!label.trim() || label.trim() === friend.label}>
            Save
          </button>
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
