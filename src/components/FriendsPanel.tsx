import { Button } from '@aeon-ui/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Chain } from '../wallet/vault'
import { filterFriends, suggestFriends } from '../features/friends'
import { listFriends, subscribeFriends, type Friend } from '../wallet/friends'
import {
  getCollectionView,
  subscribeCollectionView,
  type CollectionView,
} from '../wallet/collectionView'
import { openAddFriend, openFriendDetails, openMessagesInbox } from '../wallet/navStore'
import { withSoftSound } from '../wallet/soundedAction'
import { CollectionViewToggle } from './CollectionViewToggle'
import { EmptyState } from './EmptyState'
import { MessagesIcon, PersonAddIcon } from './icons'
import { FriendIdentityBlock } from './PeerIdentity'
import { PanelFilter } from './PanelFilter'

type Props = {
  chain: Chain
}

const openAddFriendSoftly = withSoftSound(openAddFriend)
const openMessagesSoftly = withSoftSound(openMessagesInbox)

function friendKeyLine(friend: Friend, className: string) {
  return (
    <span className={className} title={friend.identityKey}>
      {friend.identityKey}
    </span>
  )
}

function FriendListItem({ friend, chain }: { friend: Friend; chain: Chain }) {
  return (
    <li className="friend-row">
      <button type="button" className="friend-row-main" onClick={withSoftSound(() => openFriendDetails(friend.id))}>
        <FriendIdentityBlock
          chain={chain}
          friend={friend}
          bodyClassName="friend-row-body"
          name={<strong className="friend-label">{friend.label}</strong>}
          fallback={friendKeyLine(friend, 'friend-key mono')}
        />
      </button>
    </li>
  )
}

function FriendGridItem({ friend, chain }: { friend: Friend; chain: Chain }) {
  return (
    <li className="collection-grid-card friend-grid-card">
      <button type="button" className="collection-grid-main" onClick={withSoftSound(() => openFriendDetails(friend.id))}>
        <FriendIdentityBlock
          chain={chain}
          friend={friend}
          avatarClassName="friend-avatar friend-avatar-lg"
          name={<strong className="collection-grid-name">{friend.label}</strong>}
          fallback={friendKeyLine(friend, 'collection-grid-host friend-key mono')}
        />
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

  const filtered = useMemo(() => filterFriends(friends, query), [friends, query])
  const suggest = useCallback(
    (typed: string, applied: readonly string[]) => suggestFriends(friends, typed, applied),
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
            suggest={suggest}
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
            onClick={openMessagesSoftly}
          >
            <MessagesIcon size={16} />
          </button>
          <button
            type="button"
            className="panel-icon-btn"
            aria-label="Add friend"
            title="Add friend"
            onClick={openAddFriendSoftly}
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
            <Button.Root variant="solid" className="btn btn-primary" onClick={openAddFriendSoftly}>
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
