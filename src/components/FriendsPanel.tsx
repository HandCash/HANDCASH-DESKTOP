import { Button } from '@aeon-ui/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Chain } from '../wallet/vault'
import {
  listFriends,
  searchFriends,
  subscribeFriends,
  type Friend,
} from '../wallet/friends'
import {
  getCollectionView,
  subscribeCollectionView,
  type CollectionView,
} from '../wallet/collectionView'
import { openAddFriend, openFriendDetails, openMessagesInbox } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { usePeerIdentity } from '../hooks/usePeerIdentity'
import { CollectionViewToggle } from './CollectionViewToggle'
import { EmptyState } from './EmptyState'
import { MessagesIcon, PersonAddIcon } from './icons'
import { PeerAvatar, PeerIdentityLine } from './PeerIdentity'
import { PanelFilter } from './PanelFilter'

type Props = {
  chain: Chain
}

function FriendListItem({ friend, chain }: { friend: Friend; chain: Chain }) {
  const peer = usePeerIdentity(chain, friend.identityKey, friend)
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
        <PeerAvatar label={friend.label} peer={peer} />
        <div className="friend-row-body">
          <strong className="friend-label">{friend.label}</strong>
          {peer ? (
            <PeerIdentityLine peer={peer} />
          ) : (
            <span className="friend-key mono" title={friend.identityKey}>
              {friend.identityKey}
            </span>
          )}
        </div>
      </button>
    </li>
  )
}

function FriendGridItem({ friend, chain }: { friend: Friend; chain: Chain }) {
  const peer = usePeerIdentity(chain, friend.identityKey, friend)
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
        <PeerAvatar label={friend.label} peer={peer} className="friend-avatar friend-avatar-lg" />
        <strong className="collection-grid-name">{friend.label}</strong>
        {peer ? (
          <PeerIdentityLine peer={peer} />
        ) : (
          <span className="collection-grid-host friend-key mono" title={friend.identityKey}>
            {friend.identityKey}
          </span>
        )}
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

  const filtered = useMemo(
    () => query.split(',').reduce((left, term) => searchFriends(term, left), friends),
    [friends, query],
  )
  const suggestFriends = useCallback(
    (typed: string, applied: readonly string[]) => {
      const needle = typed.trim().toLowerCase()
      if (!needle) return []
      const left = applied.reduce((rest, term) => searchFriends(term, rest), friends)
      return left
        .filter((f) => f.label.toLowerCase().includes(needle))
        .sort((a, b) => Number(!a.label.toLowerCase().startsWith(needle)) - Number(!b.label.toLowerCase().startsWith(needle)))
        .slice(0, 6)
        .map((f) => ({ term: f.label, label: f.label, kind: 'Friend', count: searchFriends(f.label, left).length }))
    },
    [friends],
  )

  return (
    <div
      className="nav-section-body nav-section-with-scroll"
      data-aeon-scope="friends"
      data-aeon-state={view}
    >
      <div className="connected-panel-head friends-panel-head">
        <h2>
          Friends
          <span className="friends-count" aria-label={`${friends.length} friends`}>
            {friends.length}
          </span>
        </h2>
        {friends.length === 0 ? null : (
          <PanelFilter
            id="friends-search-input"
            label="Search friends by name or wallet key"
            placeholder="Name or wallet key"
            value={query}
            onValueChange={setQuery}
            suggest={suggestFriends}
            shown={filtered.length}
            total={friends.length}
          />
        )}
        <div className="friends-panel-head-actions panel-icon-toolbar">
          <button
            type="button"
            className="panel-icon-btn"
            aria-label="Open messages"
            title="Messages"
            onClick={() => {
              playWalletSound('soft')
              openMessagesInbox()
            }}
          >
            <MessagesIcon size={16} />
          </button>
          <button
            type="button"
            className="panel-icon-btn"
            aria-label="Add friend"
            title="Add friend"
            onClick={() => {
              playWalletSound('soft')
              openAddFriend()
            }}
          >
            <PersonAddIcon size={16} />
          </button>
          <CollectionViewToggle label="Friends view" scope="friends" />
        </div>
      </div>
      {friends.length === 0 ? (
        <EmptyState
          icon={<PersonAddIcon size={28} />}
          title="No friends yet"
          body="Add someone by $handle or wallet key."
          action={
            <Button.Root variant="solid"
              className="btn btn-primary"
              onClick={() => {
                playWalletSound('soft')
                openAddFriend()
              }}
            >
              <Button.Label>Add friend</Button.Label>
            </Button.Root>
          }
        />
      ) : (
        <div className="nav-section-scroll-body">
          {filtered.length === 0 ? (
            <div className="friends-empty">
              <strong>No friends found</strong>
              <span>Try another name or wallet key.</span>
            </div>
          ) : view === 'grid' ? (
            <ul className="collection-grid friends-grid">
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
        </div>
      )}
    </div>
  )
}
