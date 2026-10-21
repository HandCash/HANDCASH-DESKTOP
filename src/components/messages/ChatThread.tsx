import type { Ref } from 'react'
import { Button, Thread } from '@aeon-ui/react'
import type { PeerIdentityView } from '../../hooks/usePeerIdentity'
import { activityEntryTitle, type ActivityEntry } from '../../features/activity'
import {
  formatActivityWhen,
  threadEmptyCopy,
  type ChatMessage,
  type ChatThreadSection,
  type PaymentTimelineRow,
} from '../../features/messages'
import { formatSatsLabel } from '../../wallet/brc218'
import type { Friend } from '../../wallet/friends'
import { openPaymentDetails } from '../../wallet/navStore'
import { EmptyState } from '../EmptyState'
import { PeerIdentityBlock } from '../PeerIdentity'
import { MessageBubble, type MessageActions } from './MessageBubble'

export function ChatThreadHeader({
  friend,
  peer,
  onBack,
}: {
  friend: Friend
  peer: PeerIdentityView | null
  /** Absent when the thread stands alone with no list to go back to. */
  onBack?: () => void
}) {
  return (
    <header className="chat-thread-head panel-label-bar">
      {onBack ? (
        <Button.Root
          variant="ghost"
          className="chat-back-btn btn btn-ghost btn-icon"
          aria-label="Back to conversations"
          onClick={onBack}
        >
          <Button.Label>←</Button.Label>
        </Button.Root>
      ) : null}
      <PeerIdentityBlock
        label={friend.label}
        peer={peer}
        avatarClassName="friend-avatar chat-thread-avatar"
        bodyClassName="chat-thread-titles"
        name={<strong>{friend.label}</strong>}
        fallback={<span className="chat-thread-sub">1:1 · Message · Tip · Pay · Files</span>}
      />
    </header>
  )
}

const THREAD_TABS: ReadonlyArray<{ section: ChatThreadSection; label: string }> = [
  { section: 'messages', label: 'Messages' },
  { section: 'files', label: 'Files' },
  { section: 'payments', label: 'Payments' },
]

export function ChatThreadTabs({
  section,
  onSectionChange,
}: {
  section: ChatThreadSection
  onSectionChange: (section: ChatThreadSection) => void
}) {
  return (
    <nav className="chat-thread-tabs panel-label-bar" aria-label="Thread sections">
      {THREAD_TABS.map((tab) => (
        <button
          key={tab.section}
          type="button"
          className="chat-thread-tab"
          data-active={section === tab.section ? '' : undefined}
          aria-current={section === tab.section ? 'page' : undefined}
          onClick={() => onSectionChange(tab.section)}
        >
          {tab.label}
        </button>
      ))}
      <button type="button" className="chat-thread-tab" disabled title="Coming soon">
        Notes
      </button>
    </nav>
  )
}

function PaymentActivityRow({ entry }: { entry: ActivityEntry }) {
  return (
    <button
      type="button"
      className="chat-payment-activity-row"
      onClick={() => openPaymentDetails(entry.id)}
    >
      <span className="chat-payment-activity-title">{activityEntryTitle(entry)}</span>
      <span className="chat-payment-activity-meta">
        {entry.sats > 0 ? formatSatsLabel(entry.sats) : null}
        {entry.sats > 0 ? ' · ' : null}
        {formatActivityWhen(entry.at)}
      </span>
    </button>
  )
}

export function ChatThreadList({
  section,
  visibleMessages,
  timeline,
  peerLabel,
  peer,
  actions,
  listRef,
  endRef,
}: {
  section: ChatThreadSection
  visibleMessages: readonly ChatMessage[]
  /** Set on the Payments tab only: chat cards and wallet activity in time order. */
  timeline: readonly PaymentTimelineRow[] | null
  peerLabel: string
  peer: PeerIdentityView | null
  actions: MessageActions
  listRef: Ref<HTMLDivElement>
  endRef: Ref<HTMLDivElement>
}) {
  const empty = section === 'payments' ? timeline?.length === 0 : visibleMessages.length === 0
  const bubble = (msg: ChatMessage) => (
    <MessageBubble key={msg.id} msg={msg} peerLabel={peerLabel} peer={peer} {...actions} />
  )
  return (
    <Thread.Root className="chat-thread-messages">
      <Thread.List ref={listRef} className="chat-thread-list">
        {empty ? (
          <EmptyState {...threadEmptyCopy(section)} />
        ) : section === 'payments' && timeline ? (
          timeline.map((row) =>
            row.kind === 'message' ? bubble(row.message) : <PaymentActivityRow key={row.entry.id} entry={row.entry} />,
          )
        ) : (
          visibleMessages.map(bubble)
        )}
        <div ref={endRef} />
      </Thread.List>
    </Thread.Root>
  )
}
