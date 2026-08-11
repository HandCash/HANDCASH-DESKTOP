import { useEffect, useMemo, useState } from 'react'
import type { Chain } from '../wallet/vault'
import {
  addressFromIdentityKey,
  listFriends,
  subscribeFriends,
  type Friend,
} from '../wallet/friends'
import {
  getCollectionView,
  subscribeCollectionView,
  type CollectionView,
} from '../wallet/collectionView'
import { openAddFriend, openFriendDetails } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { CollectionViewToggle } from './CollectionViewToggle'
import { EmptyState } from './EmptyState'
import { PersonAddIcon } from './icons'

type Props = {
  chain: Chain
}

function friendInitial(label: string): string {
  const t = label.trim()
  return t ? t.slice(0, 1).toUpperCase() : '?'
}

function FriendListItem({ friend, chain }: { friend: Friend; chain: Chain }) {
  let address = ''
  try {
    address = addressFromIdentityKey(friend.identityKey, chain)
  } catch {
    address = 'Invalid key'
  }

  return (
    <li className="friend-row">
      <button
        type="button"
        className="friend-row-main"
        onClick={() => {
          playWalletSound('soft')
          openFriendDetails(friend.id)
        }}
      >
        <span className="friend-avatar" aria-hidden>
          {friendInitial(friend.label)}
        </span>
        <div className="friend-row-body">
          <strong className="friend-label">{friend.label}</strong>
          <span className="friend-key mono" title={friend.identityKey}>
            {friend.identityKey}
          </span>
          <span className="friend-address mono" title={address}>
            {address}
          </span>
        </div>
      </button>
    </li>
  )
}

function FriendGridItem({ friend, chain }: { friend: Friend; chain: Chain }) {
  let address = ''
  try {
    address = addressFromIdentityKey(friend.identityKey, chain)
  } catch {
    address = 'Invalid key'
  }

  return (
    <li className="collection-grid-card friend-grid-card">
      <button
        type="button"
        className="collection-grid-main"
        onClick={() => {
          playWalletSound('soft')
          openFriendDetails(friend.id)
        }}
      >
        <span className="friend-avatar friend-avatar-lg" aria-hidden>
          {friendInitial(friend.label)}
        </span>
        <strong className="collection-grid-name">{friend.label}</strong>
        <span className="collection-grid-host friend-key mono" title={friend.identityKey}>
          {friend.identityKey}
        </span>
        <span className="friend-grid-address mono" title={address}>
          {address}
        </span>
      </button>
    </li>
  )
}

export function FriendsPanel({ chain }: Props) {
  const [friends, setFriends] = useState<Friend[]>(() => listFriends())
  const [view, setView] = useState<CollectionView>(() => getCollectionView('friends'))
  const [query, setQuery] = useState('')

  useEffect(() => subscribeFriends(setFriends), [])
  useEffect(() => subscribeCollectionView(setView, 'friends'), [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return friends
    return friends.filter(
      (f) =>
        f.label.toLowerCase().includes(q) ||
        f.identityKey.toLowerCase().includes(q),
    )
  }, [friends, query])

  return (
    <div
      className="nav-section-body"
      data-aeon-scope="friends"
      data-aeon-state={view}
    >
      <div className="connected-panel-head friends-panel-head">
        <h2>Friends</h2>
        <button
          type="button"
          className="friends-add-btn"
          aria-label="Add friend"
          title="Add friend"
          onClick={() => {
            playWalletSound('soft')
            openAddFriend()
          }}
        >
          <PersonAddIcon size={18} />
          <span>Add friend</span>
        </button>
        <div className="connected-panel-head-actions">
          <CollectionViewToggle label="Friends view" scope="friends" />
        </div>
      </div>

      {friends.length === 0 ? (
        <EmptyState
          icon={<PersonAddIcon size={28} />}
          title="No friends yet"
          body="Add someone by $handle or identity key so you can send and recognize them quickly."
          action={
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                playWalletSound('soft')
                openAddFriend()
              }}
            >
              Add friend
            </button>
          }
        />
      ) : (
        <>
          <div className="friends-search">
            <input
              type="search"
              placeholder="Search friends"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
            />
          </div>
          {filtered.length === 0 ? (
            <p className="friends-empty">No matches</p>
          ) : view === 'grid' ? (
            <ul className="collection-grid">
              {filtered.map((friend) => (
                <FriendGridItem key={friend.id} friend={friend} chain={chain} />
              ))}
            </ul>
          ) : (
            <ul className="friends-list">
              {filtered.map((friend) => (
                <FriendListItem key={friend.id} friend={friend} chain={chain} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
