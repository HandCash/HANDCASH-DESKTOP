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
import { sinceText } from '../wallet/listPanelText'
import { openAddFriend, openFriendDetails, openMessagesInbox } from '../wallet/navStore'
import { withSoftSound } from '../wallet/soundedAction'
import { CollectionViewToggle } from './CollectionViewToggle'
import { EmptyState } from './EmptyState'
import { CallIcon, MessagesIcon, PersonAddIcon, SearchIcon } from './icons'
import { callEngine } from '../wallet/calls/callService'
import { ListPanelHead } from './ListPanelHead'
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

function FriendListItem({ friend, chain, now }: { friend: Friend; chain: Chain; now: number }) {
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
        <span className="friend-row-since" data-aeon-part="since">
          Added {sinceText(friend.createdAt, now)}
        </span>
      </button>
      <button
        type="button"
        className="friend-row-call"
        data-aeon-part="call"
        aria-label={`Call ${friend.label}`}
        title="Call"
        onClick={() => callEngine().call(friend.identityKey)}
      >
        <CallIcon size={18} />
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

type ResultsProps = {
  friends: Friend[]
  query: string
  view: CollectionView
  chain: Chain
  now: number
}

/** What sits under the search: the empty state, no matches, or the friend list or grid. */
export function FriendsResults({ friends, query, view, chain, now }: ResultsProps) {
  if (friends.length === 0) {
    return (
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
    )
  }
  const shown = filterFriends(friends, query)
  if (shown.length === 0) {
    return (
      <EmptyState
        icon={<SearchIcon size={28} />}
        title="No friends found"
        body={`Nothing matches “${query.trim()}”. Try another name or wallet key.`}
      />
    )
  }
  return view === 'grid' ? (
    <ul className="collection-grid friends-grid">
      {shown.map((friend) => (
        <FriendGridItem key={friend.id} friend={friend} chain={chain} />
      ))}
    </ul>
  ) : (
    <ul className="friends-list">
      {shown.map((friend) => (
        <FriendListItem key={friend.id} friend={friend} chain={chain} now={now} />
      ))}
    </ul>
  )
}

export function FriendsPanel({ chain }: Props) {
  const [friends, setFriends] = useState<Friend[]>(() => listFriends())
  const [view, setView] = useState<CollectionView>(() => getCollectionView('friends'))
  const [query, setQuery] = useState('')

  useEffect(() => subscribeFriends(setFriends), [])
  useEffect(() => subscribeCollectionView(setView, 'friends'), [])

  const shownCount = useMemo(() => filterFriends(friends, query).length, [friends, query])
  const suggest = useCallback(
    (typed: string, applied: readonly string[]) => suggestFriends(friends, typed, applied),
    [friends],
  )
  const results = (
    <FriendsResults friends={friends} query={query} view={view} chain={chain} now={Date.now()} />
  )

  return (
    <div
      className="nav-section-body nav-section-with-scroll"
      data-aeon-scope="friends"
      data-aeon-state={view}
    >
      <ListPanelHead
        title="Friends"
        count={friends.length}
        countLabel={`${friends.length} ${friends.length === 1 ? 'friend' : 'friends'}`}
        actions={
          <>
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
            {friends.length > 0 ? <CollectionViewToggle label="Friends view" scope="friends" /> : null}
          </>
        }
        search={
          friends.length === 0 ? null : (
            <PanelFilter
              id="friends-search-input"
              label="Search friends by name or wallet key"
              placeholder="Name or wallet key"
              value={query}
              onValueChange={setQuery}
              suggest={suggest}
              shown={shownCount}
              total={friends.length}
            />
          )
        }
      />
      {friends.length === 0 ? results : <div className="nav-section-scroll-body">{results}</div>}
    </div>
  )
}
