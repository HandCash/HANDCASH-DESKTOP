import { useEffect, useState, type FormEvent } from 'react'
import type { Chain } from '../wallet/vault'
import {
  addFriend,
  addressFromIdentityKey,
  listFriends,
  removeFriend,
  subscribeFriends,
  type Friend,
} from '../wallet/friends'

type Props = {
  chain: Chain
}

function shortenKey(key: string): string {
  if (key.length <= 18) return key
  return `${key.slice(0, 8)}…${key.slice(-8)}`
}

export function FriendsPanel({ chain }: Props) {
  const [friends, setFriends] = useState<Friend[]>(() => listFriends())
  const [label, setLabel] = useState('')
  const [identityKey, setIdentityKey] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => subscribeFriends(setFriends), [])

  const onAdd = (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      addFriend({ label, identityKey })
      setLabel('')
      setIdentityKey('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="nav-section-body" data-aeon-scope="friends">
      <div className="connected-panel-head">
        <h2>Friends</h2>
      </div>

      <form className="friends-add-form" onSubmit={onAdd}>
        <div className="field">
          <label htmlFor="friend-label">Label</label>
          <input
            id="friend-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Alice"
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label htmlFor="friend-key">Identity key</label>
          <input
            id="friend-key"
            className="mono"
            value={identityKey}
            onChange={(e) => setIdentityKey(e.target.value)}
            placeholder="02… or 03…"
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
          <button type="submit" className="btn btn-primary" disabled={!label.trim() || !identityKey.trim()}>
            Add friend
          </button>
        </div>
      </form>

      {friends.length === 0 ? (
        <p className="connected-empty-line">No friends yet</p>
      ) : (
        <ul className="friends-list">
          {friends.map((friend) => {
            let address = ''
            try {
              address = addressFromIdentityKey(friend.identityKey, chain)
            } catch {
              address = 'Invalid key'
            }
            return (
              <li key={friend.id} className="friend-row">
                <div className="friend-row-body">
                  <strong className="friend-label">{friend.label}</strong>
                  <span className="friend-key mono" title={friend.identityKey}>
                    {shortenKey(friend.identityKey)}
                  </span>
                  <span className="friend-address mono" title={address}>
                    {address}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-compact"
                  onClick={() => removeFriend(friend.id)}
                >
                  Remove
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
