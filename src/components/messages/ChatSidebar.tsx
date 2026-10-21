import { Button } from '@aeon-ui/react'
import { usePeerIdentity } from '../../hooks/usePeerIdentity'
import { formatDay, unreadBadgeLabel, type ChatPeer } from '../../features/messages'
import { openAddFriend } from '../../wallet/navStore'
import type { Chain } from '../../wallet/vault'
import { PersonAddIcon } from '../icons'
import { PeerAvatar } from '../PeerIdentity'
import { SearchField } from '../SearchField'

function ChatPeerAvatar({ label, identityKey, chain }: { label: string; identityKey?: string; chain: Chain }) {
  const peer = usePeerIdentity(chain, identityKey)
  return <PeerAvatar label={label} peer={peer} />
}

function SidebarTools({
  unreadOnly,
  onUnreadOnlyChange,
}: {
  unreadOnly: boolean
  onUnreadOnlyChange: (value: boolean) => void
}) {
  return (
    <>
      <label className="chat-unread-toggle" title="Unread only">
        <input
          type="checkbox"
          checked={unreadOnly}
          onChange={(e) => onUnreadOnlyChange(e.target.checked)}
        />
        <span>Unread</span>
      </label>
      <Button.Root
        variant="ghost"
        className="btn btn-ghost btn-icon"
        title="Add friend"
        aria-label="Add friend"
        onClick={() => openAddFriend()}
      >
        <PersonAddIcon size={18} />
      </Button.Root>
    </>
  )
}

function ChatPeerRow({
  peer: { peerId, friend, thread },
  chain,
  selected,
  onSelect,
}: {
  peer: ChatPeer
  chain: Chain
  selected: boolean
  onSelect: (peerId: string) => void
}) {
  const label = friend?.label ?? 'Unknown'
  const unreadCount = thread?.unread ?? 0
  return (
    <button
      type="button"
      className="chat-peer-row"
      data-selected={selected ? '' : undefined}
      onClick={() => onSelect(peerId)}
    >
      <ChatPeerAvatar label={label} identityKey={friend?.identityKey} chain={chain} />
      <span className="chat-peer-body">
        <span className="chat-peer-top">
          <strong className="chat-peer-name">{label}</strong>
          {thread?.updatedAt ? <span className="chat-peer-when">{formatDay(thread.updatedAt)}</span> : null}
        </span>
        <span className="chat-peer-preview">{thread?.lastPreview || ' '}</span>
      </span>
      {unreadCount > 0 ? (
        <span className="chat-unread-badge" aria-label={`${unreadCount} unread`}>
          {unreadBadgeLabel(unreadCount)}
        </span>
      ) : null}
    </button>
  )
}

export function ChatSidebar({
  chain,
  nestedInNav,
  peers,
  filteredPeers,
  activePeerId,
  query,
  onQueryChange,
  unreadOnly,
  onUnreadOnlyChange,
  onSelectPeer,
}: {
  chain: Chain
  nestedInNav: boolean
  peers: readonly ChatPeer[]
  filteredPeers: readonly ChatPeer[]
  activePeerId: string | null
  query: string
  onQueryChange: (value: string) => void
  unreadOnly: boolean
  onUnreadOnlyChange: (value: boolean) => void
  onSelectPeer: (peerId: string) => void
}) {
  const tools = <SidebarTools unreadOnly={unreadOnly} onUnreadOnlyChange={onUnreadOnlyChange} />
  return (
    <aside className="chat-sidebar">
      {!nestedInNav ? (
        <div className="chat-sidebar-head panel-label-bar">
          <h2>Messages</h2>
          <div className="chat-sidebar-tools">{tools}</div>
        </div>
      ) : (
        <div className="chat-sidebar-toolbar panel-label-bar">{tools}</div>
      )}
      <div className="root-search chat-search" role="search">
        <SearchField
          id="chat-search-input"
          label="Search conversations"
          placeholder="Name or message"
          value={query}
          onValueChange={onQueryChange}
        />
      </div>
      <ul className="chat-peer-list">
        {filteredPeers.length === 0 ? (
          <li className="chat-empty">{peers.length === 0 ? 'No chats yet — add a friend' : 'No matches'}</li>
        ) : (
          filteredPeers.map((peer) => (
            <li key={peer.peerId}>
              <ChatPeerRow
                peer={peer}
                chain={chain}
                selected={activePeerId === peer.peerId}
                onSelect={onSelectPeer}
              />
            </li>
          ))
        )}
      </ul>
    </aside>
  )
}
