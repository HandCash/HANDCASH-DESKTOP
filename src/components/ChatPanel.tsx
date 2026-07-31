import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { Chain } from '../wallet/vault'
import {
  addressFromIdentityKey,
  getFriendById,
  listFriends,
  subscribeFriends,
  type Friend,
} from '../wallet/friends'
import {
  appendMessage,
  listChatPeers,
  listMessages,
  subscribeChat,
  type ChatMessage,
} from '../wallet/chatStore'
import {
  helpText,
  normalizeChatText,
  parseLocalCommand,
  type ParsedAmount,
} from '../wallet/brc218'
import { openSendFlow, openAddFriend } from '../wallet/navStore'
import { setSendPrefill } from '../wallet/sendPrefill'
import { amountToSats, getCachedUsdPerBsv } from '../wallet/fx'
import { playWalletSound } from '../wallet/soundService'
import { subscribeChatFocus, takeChatFocus } from '../wallet/chatFocus'
import { PersonAddIcon, SendIcon } from './icons'

type Props = {
  chain: Chain
}

function friendInitial(label: string): string {
  const t = label.trim()
  return t ? t.slice(0, 1).toUpperCase() : '?'
}

function formatTime(ts: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(ts)
  } catch {
    return ''
  }
}

function resolvePeer(
  token: string | undefined,
  friends: Friend[],
  current: Friend | null,
): Friend | null {
  if (!token) return current
  const q = token.replace(/^@/, '').toLowerCase()
  return (
    friends.find((f) => f.label.toLowerCase() === q) ||
    friends.find((f) => f.identityKey.toLowerCase().startsWith(q)) ||
    friends.find((f) => f.id === token) ||
    null
  )
}

function amountToSendPrefill(amount: ParsedAmount | undefined): {
  amount?: string
  amountUnit?: 'usd' | 'bsv' | 'sats'
  sats?: number
} {
  if (!amount) return {}
  if (amount.kind === 'sats') {
    return { amount: String(amount.sats), amountUnit: 'sats', sats: amount.sats }
  }
  const usdPerBsv = getCachedUsdPerBsv()
  const sats = amountToSats(String(amount.value), 'usd', usdPerBsv)
  return { amount: String(amount.value), amountUnit: 'usd', sats: sats > 0 ? sats : undefined }
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  if (msg.direction === 'system' || msg.kind === 'system') {
    return (
      <div className="chat-system" role="status">
        <pre>{msg.text}</pre>
      </div>
    )
  }

  const mine = msg.direction === 'out'
  return (
    <div className={`chat-bubble-row${mine ? ' is-mine' : ''}`}>
      <div
        className={`chat-bubble${mine ? ' is-mine' : ''}${msg.kind === 'pay-request' ? ' is-card' : ''}${msg.kind === 'pay-sent' ? ' is-card' : ''}`}
        data-kind={msg.kind}
      >
        {msg.kind === 'pay-request' ? (
          <>
            <strong className="chat-card-title">Payment request</strong>
            <p className="chat-card-amount">{msg.meta?.amountLabel ?? msg.text}</p>
            {msg.meta?.status ? <span className="chat-card-meta">{msg.meta.status}</span> : null}
          </>
        ) : msg.kind === 'pay-sent' ? (
          <>
            <strong className="chat-card-title">Payment</strong>
            <p className="chat-card-amount">{msg.meta?.amountLabel ?? msg.text}</p>
            <span className="chat-card-meta">{msg.meta?.status ?? 'Opened in Send'}</span>
          </>
        ) : (
          <p className="chat-bubble-text">{msg.text}</p>
        )}
        <time className="chat-bubble-time" dateTime={new Date(msg.createdAt).toISOString()}>
          {formatTime(msg.createdAt)}
        </time>
      </div>
    </div>
  )
}

export function ChatPanel({ chain }: Props) {
  const [friends, setFriends] = useState(() => listFriends())
  const [peers, setPeers] = useState(() => listChatPeers())
  const [activePeerId, setActivePeerId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const threadEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const refresh = () => {
    setFriends(listFriends())
    setPeers(listChatPeers())
  }

  useEffect(() => subscribeFriends(refresh), [])
  useEffect(() => subscribeChat(refresh), [])

  useEffect(() => {
    return subscribeChatFocus((peerId) => {
      if (!peerId) return
      setActivePeerId(peerId)
      takeChatFocus()
    })
  }, [])

  const activeFriend = activePeerId ? getFriendById(activePeerId) : null
  const messages = useMemo(
    () => (activePeerId ? listMessages(activePeerId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh via peers/messages tick
    [activePeerId, peers],
  )

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, activePeerId])

  const openPay = (friend: Friend, amount?: ParsedAmount, memo?: string) => {
    let address = ''
    try {
      address = addressFromIdentityKey(friend.identityKey, chain)
    } catch {
      setHint('Cannot resolve payment address for this identity.')
      playWalletSound('error')
      return
    }
    const pre = amountToSendPrefill(amount)
    setSendPrefill({
      to: address,
      friendLabel: friend.label,
      amount: pre.amount,
      amountUnit: pre.amountUnit,
      memo,
    })
    appendMessage(friend.id, {
      direction: 'out',
      kind: 'pay-sent',
      text: `Pay ${pre.amount ? (amount?.label ?? pre.amount) : ''} → ${friend.label}`.trim(),
      meta: {
        amountLabel: amount?.label,
        sats: pre.sats,
        status: 'Confirm in Send',
      },
    })
    playWalletSound('soft')
    openSendFlow()
  }

  const handleCompose = (rawLine: string) => {
    const line = rawLine.trim()
    if (!line) return
    setHint(null)

    // Literal slash chat
    if (line.startsWith('//')) {
      if (!activePeerId || !activeFriend) {
        setHint('Pick a friend thread first.')
        return
      }
      appendMessage(activePeerId, {
        direction: 'out',
        kind: 'text',
        text: normalizeChatText(line),
      })
      playWalletSound('soft')
      setDraft('')
      return
    }

    const cmd = parseLocalCommand(line)
    if (!cmd) {
      if (!activePeerId || !activeFriend) {
        setHint('Pick a friend on the left, or start with /help')
        return
      }
      appendMessage(activePeerId, { direction: 'out', kind: 'text', text: line })
      playWalletSound('soft')
      setDraft('')
      return
    }

    if (cmd.verb === 'help') {
      const peer = activePeerId ?? friends[0]?.id
      if (peer) {
        appendMessage(peer, { direction: 'system', kind: 'system', text: helpText() })
        setActivePeerId(peer)
      } else {
        setHint(helpText())
      }
      setDraft('')
      return
    }

    if (cmd.verb === 'unsupported') {
      setHint(`Unsupported command /${cmd.name}. Try /help`)
      playWalletSound('error')
      return
    }

    const peerFriend = resolvePeer(
      'recipient' in cmd ? cmd.recipient : undefined,
      friends,
      activeFriend,
    )

    if (cmd.verb === 'whois') {
      const target = peerFriend ?? activeFriend
      if (!target) {
        setHint('Add a friend first, then /whois')
        return
      }
      let address = ''
      try {
        address = addressFromIdentityKey(target.identityKey, chain)
      } catch {
        address = '(invalid key)'
      }
      setActivePeerId(target.id)
      appendMessage(target.id, {
        direction: 'system',
        kind: 'system',
        text: [
          `whois ${target.label}`,
          `identity: ${target.identityKey}`,
          `address: ${address}`,
          `chain: ${chain}`,
        ].join('\n'),
      })
      playWalletSound('soft')
      setDraft('')
      return
    }

    if (!peerFriend) {
      setHint('Unknown recipient. Add them in Friends, or open their thread.')
      playWalletSound('error')
      return
    }

    setActivePeerId(peerFriend.id)

    if (cmd.verb === 'message') {
      const text = cmd.text?.trim()
      if (!text) {
        setHint('Usage: /message [recipient] <text>')
        return
      }
      appendMessage(peerFriend.id, { direction: 'out', kind: 'text', text })
      playWalletSound('soft')
      setDraft('')
      return
    }

    if (cmd.verb === 'request') {
      if (!cmd.amount) {
        setHint('Usage: /request [recipient] <$amount|N sats> [memo]')
        return
      }
      appendMessage(peerFriend.id, {
        direction: 'out',
        kind: 'pay-request',
        text: cmd.memo || cmd.amount.label,
        meta: {
          amountLabel: cmd.amount.label,
          sats: amountToSendPrefill(cmd.amount).sats,
          status: 'Awaiting counterparty (local card)',
        },
      })
      playWalletSound('soft')
      setDraft('')
      return
    }

    if (cmd.verb === 'pay' || cmd.verb === 'tip') {
      const amount = cmd.verb === 'tip' ? cmd.amount : cmd.amount
      if (cmd.verb === 'pay' && !amount) {
        setHint('Usage: /pay [recipient] <$amount|N sats> [memo]')
        return
      }
      // tip without amount → open send blank to this peer
      openPay(peerFriend, amount, cmd.verb === 'pay' ? cmd.memo : undefined)
      setDraft('')
      return
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    handleCompose(draft)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleCompose(draft)
    }
  }

  return (
    <div className="chat-shell" data-aeon-scope="chat" data-aeon-state={activePeerId ? 'thread' : 'list'}>
      <aside className="chat-sidebar">
        <div className="chat-sidebar-head">
          <h2>Chat</h2>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            title="Add friend"
            aria-label="Add friend"
            onClick={() => openAddFriend()}
          >
            <PersonAddIcon size={18} />
          </button>
        </div>
        <p className="chat-banner">
          BSV identity chat · BRC-218 commands · peer relay coming with BRC-169
        </p>
        <ul className="chat-peer-list">
          {peers.length === 0 ? (
            <li className="chat-empty">Add friends to start chatting</li>
          ) : (
            peers.map(({ peerId, friend, thread }) => {
              const label = friend?.label ?? 'Unknown'
              const selected = activePeerId === peerId
              return (
                <li key={peerId}>
                  <button
                    type="button"
                    className="chat-peer-row"
                    data-selected={selected ? '' : undefined}
                    onClick={() => setActivePeerId(peerId)}
                  >
                    <span className="friend-avatar" aria-hidden>
                      {friendInitial(label)}
                    </span>
                    <span className="chat-peer-body">
                      <strong>{label}</strong>
                      <span className="chat-peer-preview">
                        {thread?.lastPreview || 'No messages yet'}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })
          )}
        </ul>
      </aside>

      <section className="chat-thread">
        {activeFriend ? (
          <>
            <header className="chat-thread-head">
              <span className="friend-avatar" aria-hidden>
                {friendInitial(activeFriend.label)}
              </span>
              <div>
                <strong>{activeFriend.label}</strong>
                <span className="chat-thread-sub mono" title={activeFriend.identityKey}>
                  {activeFriend.identityKey.slice(0, 18)}…
                </span>
              </div>
            </header>

            <div className="chat-thread-messages">
              {messages.length === 0 ? (
                <div className="chat-system">
                  <pre>
                    {`Say hi to ${activeFriend.label}.\nTry /pay $1 or /whois\n/help for BRC-218 commands`}
                  </pre>
                </div>
              ) : (
                messages.map((m) => <MessageBubble key={m.id} msg={m} />)
              )}
              <div ref={threadEndRef} />
            </div>

            {hint ? <p className="chat-hint">{hint}</p> : null}

            <form className="chat-composer" onSubmit={onSubmit}>
              <textarea
                ref={inputRef}
                className="chat-input"
                rows={1}
                placeholder="Message or /pay $2.18…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                autoComplete="off"
              />
              <button type="submit" className="btn btn-primary btn-icon" aria-label="Send" disabled={!draft.trim()}>
                <SendIcon size={18} />
              </button>
            </form>
          </>
        ) : (
          <div className="chat-placeholder">
            <h3>Messages</h3>
            <p>
              Telegram-style chat addressed by BSV identity keys. Slash commands follow BRC-218 —
              only what you type is executable.
            </p>
            <p className="chat-placeholder-cmds mono">/pay · /whois · /request · /tip · /help</p>
          </div>
        )}
      </section>
    </div>
  )
}
