import { useMemo, useState } from 'react'
import { stateToAttr } from '@aeon-ui/core'
import { Button } from '@aeon-ui/react'
import type { Chain } from '../wallet/vault'
import { openAddFriend } from '../wallet/navStore'
import {
  chatShellClass,
  chatShellState,
  filterPeers,
  useChatComposer,
  useChatPeerSelection,
  useMessagePeers,
  usePeerInboxPolling,
  useThreadAutoScroll,
  useThreadMessages,
} from '../features/messages'
import { CommandConfirmPrompt } from './CommandConfirmPrompt'
import { EmptyState } from './EmptyState'
import { ChatComposer } from './messages/ChatComposer'
import { ChatSidebar } from './messages/ChatSidebar'
import { ChatThreadHeader, ChatThreadList, ChatThreadTabs } from './messages/ChatThread'

type Props = {
  chain: Chain
  identityKey?: string
  /** When set, open directly in this friend's thread (Friends → Message). */
  peerId?: string
  /** Friends → Chat nav child: route peers via navStore inside the nav panel. */
  nestedInNav?: boolean
  /** @deprecated Use nestedInNav — immersive breakout chrome (unused). */
  fullscreen?: boolean
  onSent?: (balanceSats: number) => void
}

export function MessagesPanel({
  chain,
  identityKey,
  peerId,
  nestedInNav = false,
  fullscreen = false,
  onSent,
}: Props) {
  const navRouted = nestedInNav || fullscreen
  const threadOnly = Boolean(peerId) && !navRouted
  const peers = useMessagePeers()
  const [query, setQuery] = useState('')
  const [unreadOnly, setUnreadOnly] = useState(false)
  const { activePeerId, activeFriend, selectPeer, backToList } = useChatPeerSelection({
    peerId,
    navRouted,
    threadOnly,
  })
  const { threadSection, setThreadSection, messages, visibleMessages, timeline } = useThreadMessages(
    activePeerId,
    activeFriend,
    peers,
  )
  const composer = useChatComposer({
    identityKey,
    activePeerId,
    activeFriend,
    messages,
    setThreadSection,
    onSent,
  })
  usePeerInboxPolling(identityKey, activePeerId)
  const { threadListRef, threadEndRef } = useThreadAutoScroll(activePeerId, visibleMessages, peers)
  const filteredPeers = useMemo(() => filterPeers(peers, query, unreadOnly), [peers, query, unreadOnly])
  const { confirmCmd } = composer

  return (
    <div
      className={chatShellClass(nestedInNav, fullscreen)}
      data-aeon-scope="messages"
      data-aeon-state={stateToAttr(chatShellState({ navRouted, threadOnly, activePeerId }))}
    >
      {!threadOnly ? (
        <ChatSidebar
          chain={chain}
          nestedInNav={nestedInNav}
          peers={peers}
          filteredPeers={filteredPeers}
          activePeerId={activePeerId}
          query={query}
          onQueryChange={setQuery}
          unreadOnly={unreadOnly}
          onUnreadOnlyChange={setUnreadOnly}
          onSelectPeer={selectPeer}
        />
      ) : null}

      <section className="chat-thread">
        {activeFriend ? (
          <>
            {!nestedInNav ? (
              <ChatThreadHeader
                friend={activeFriend}
                chain={chain}
                onBack={threadOnly ? undefined : backToList}
              />
            ) : null}
            <ChatThreadTabs section={threadSection} onSectionChange={setThreadSection} />

            <ChatThreadList
              section={threadSection}
              visibleMessages={visibleMessages}
              timeline={timeline}
              peerLabel={activeFriend.label}
              actions={{
                onConfirmPay: composer.requestPayConfirm,
                onCancelPay: composer.cancelPay,
                onEscrowAccept: composer.acceptEscrow,
                onEscrowDecline: composer.declineEscrow,
                onBindReply: composer.bindReply,
              }}
              listRef={threadListRef}
              endRef={threadEndRef}
            />

            {composer.hint ? <p className="chat-hint">{composer.hint}</p> : null}

            <ChatComposer composer={composer} peerLabel={activeFriend.label} canAttach={Boolean(identityKey)} />

            <CommandConfirmPrompt
              open={Boolean(confirmCmd)}
              verb={confirmCmd?.verb ?? 'pay'}
              recipient={activeFriend.label}
              amountLabel={confirmCmd?.amountLabel ?? ''}
              satsLabel={confirmCmd?.satsLabel}
              effect={`Send ${confirmCmd?.amountLabel ?? 'this amount'} to ${activeFriend.label}. This moves value and cannot be undone.`}
              confirming={composer.confirming}
              onCancel={composer.cancelPayConfirm}
              onConfirm={composer.confirmPayConfirm}
            />
          </>
        ) : (
          <div className="chat-placeholder">
            <EmptyState
              title="Messages"
              body="Pick a friend to open a thread."
              action={
                <Button.Root variant="solid" className="btn btn-primary" onClick={() => openAddFriend()}>
                  <Button.Label>Add friend</Button.Label>
                </Button.Root>
              }
            />
          </div>
        )}
      </section>
    </div>
  )
}

/** @deprecated */
export const ChatPanel = MessagesPanel
