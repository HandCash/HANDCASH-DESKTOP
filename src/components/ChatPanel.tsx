import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { Chain } from '../wallet/vault'
import {
  addressFromIdentityKey,
  getFriendById,
  subscribeFriends,
  type Friend,
} from '../wallet/friends'
import {
  appendMessage,
  listChatPeers,
  listMessages,
  subscribeChat,
  updateMessage,
  type ChatMessage,
} from '../wallet/chatStore'
import { normalizeChatText, parseLocalCommand, formatFiatLabel, formatSatsLabel, type ParsedAmount } from '../wallet/brc218'
import { openAddFriend } from '../wallet/navStore'
import { amountToSats, getCachedUsdPerBsv } from '../wallet/fx'
import { getDisplayCurrency, type DisplayCurrency } from '../wallet/displayCurrency'
import { playWalletSound } from '../wallet/soundService'
import { playPaymentSuccessSound } from '../wallet/paymentSuccessSound'
import { sendSatsToAddress } from '../wallet/sendPayment'
import { subscribeChatFocus, takeChatFocus } from '../wallet/chatFocus'
import { copyText } from '../wallet/clipboard'
import {
  PayIcon,
  PersonAddIcon,
  RequestMoneyIcon,
  SendIcon,
} from './icons'

type Props = {
  chain: Chain
  onSent?: (balanceSats: number) => void
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

function shortenTxid(txid: string): string {
  if (txid.length <= 16) return txid
  return `${txid.slice(0, 8)}…${txid.slice(-6)}`
}

function resolveAmountSats(amount: ParsedAmount | undefined): {
  amountLabel?: string
  sats?: number
} {
  if (!amount) return {}
  if (amount.kind === 'sats') {
    if (amount.sats < 1) return { amountLabel: amount.label }
    return { amountLabel: amount.label, sats: amount.sats }
  }
  const usdPerBsv = getCachedUsdPerBsv()
  let sats = amountToSats(String(amount.value), 'usd', usdPerBsv)
  // Tiny USD that rounds under 1 sat still sends the chain minimum.
  if (sats < 1 && amount.value > 0 && usdPerBsv != null && usdPerBsv > 0) {
    sats = 1
  }
  const amountLabel = formatFiatLabel(amount.value, amount.currency)
  if (sats < 1) return { amountLabel }
  return { amountLabel, sats }
}

/** Default amount lead from unit of account: `$` or `… bsv`. */
function defaultAmountLead(currency: DisplayCurrency): { text: string; cursor: number } {
  if (currency === 'usd') return { text: ' $', cursor: 2 }
  return { text: '  bsv', cursor: 1 }
}

function isUnitOnlyRest(rest: string): boolean {
  const t = rest.trim()
  return !t || t === '$' || /^bsv$/i.test(t)
}

/** Switch/replace `/pay` ↔ `/request`, keep amount when present, else unit lead. */
function applyPaymentVerb(
  prev: string,
  verb: 'pay' | 'request',
): { draft: string; cursor: number } {
  const currency = getDisplayCurrency()
  const trimmed = prev.trimStart()
  const m = trimmed.match(/^\/(pay|request)(\s[\s\S]*)?$/i)
  if (m) {
    const rest = m[2] ?? ''
    if (isUnitOnlyRest(rest)) {
      const lead = defaultAmountLead(currency)
      const draft = `/${verb}${lead.text}`
      return { draft, cursor: `/${verb}`.length + lead.cursor }
    }
    const preserved = rest.startsWith(' ') ? rest : ` ${rest}`
    const draft = `/${verb}${preserved}`
    return { draft, cursor: draft.length }
  }
  const lead = defaultAmountLead(currency)
  const draft = `/${verb}${lead.text}`
  return { draft, cursor: `/${verb}`.length + lead.cursor }
}

function payStatusLabel(msg: ChatMessage): string {
  const st = msg.meta?.payStatus
  if (st === 'pending') return 'Confirm to send'
  if (st === 'sending') return 'Sending…'
  if (st === 'sent') {
    return msg.meta?.txid ? `Sent · ${shortenTxid(msg.meta.txid)}` : 'Sent'
  }
  if (st === 'failed') return msg.meta?.error ? `Failed · ${msg.meta.error}` : 'Failed'
  if (st === 'cancelled') return 'Cancelled'
  return msg.meta?.status ?? ''
}

function MessageBubble({
  msg,
  onConfirmPay,
  onCancelPay,
}: {
  msg: ChatMessage
  onConfirmPay?: (id: string) => void
  onCancelPay?: (id: string) => void
}) {
  if (msg.direction === 'system' || msg.kind === 'system') {
    return (
      <div className="chat-system" role="status">
        <pre>{msg.text}</pre>
      </div>
    )
  }

  const mine = msg.direction === 'out'
  const payStatus = msg.meta?.payStatus
  const canAct = msg.kind === 'pay-sent' && payStatus === 'pending'
  const isCard = msg.kind === 'pay-request' || msg.kind === 'pay-sent'
  const amountLabel = msg.meta?.amountLabel ?? msg.text
  const satsLine =
    msg.meta?.sats && msg.meta.sats > 0 && !/\bsats?\b/i.test(amountLabel)
      ? formatSatsLabel(msg.meta.sats)
      : null

  return (
    <div className={`chat-bubble-row${mine ? ' is-mine' : ''}`}>
      <div
        className={[
          'chat-bubble',
          mine ? 'is-mine' : '',
          isCard ? 'is-card' : '',
          msg.kind === 'pay-sent' ? 'is-pay' : '',
          msg.kind === 'pay-request' ? 'is-request' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        data-kind={msg.kind}
        data-pay-status={payStatus || undefined}
      >
        {msg.kind === 'pay-request' ? (
          <>
            <div className="chat-card-head">
              <span className="chat-card-badge">Request</span>
            </div>
            <p className="chat-card-amount">{amountLabel}</p>
            {satsLine ? <p className="chat-card-sats">{satsLine}</p> : null}
            {msg.meta?.status ? <span className="chat-card-meta">{msg.meta.status}</span> : null}
          </>
        ) : msg.kind === 'pay-sent' ? (
          <>
            <div className="chat-card-head">
              <span className="chat-card-badge">Pay</span>
              {payStatus ? (
                <span className="chat-card-status" data-status={payStatus}>
                  {payStatusLabel(msg)}
                </span>
              ) : null}
            </div>
            <p className="chat-card-amount">{amountLabel}</p>
            {satsLine ? <p className="chat-card-sats">{satsLine}</p> : null}
            {canAct ? (
              <div className="chat-card-actions">
                <button
                  type="button"
                  className="chat-card-btn chat-card-btn-ghost"
                  onClick={() => onCancelPay?.(msg.id)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="chat-card-btn chat-card-btn-primary"
                  onClick={() => onConfirmPay?.(msg.id)}
                >
                  Confirm
                </button>
              </div>
            ) : null}
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

export function ChatPanel({ chain, onSent }: Props) {
  const [peers, setPeers] = useState(() => listChatPeers())
  const [activePeerId, setActivePeerId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const threadEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const refresh = () => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- peers tick refreshes store
    [activePeerId, peers],
  )

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, activePeerId, peers])

  /** Queue an in-chat payment card — never leave Chat for Send. */
  const queuePay = (friend: Friend, amount: ParsedAmount, memo?: string) => {
    let address = ''
    try {
      address = addressFromIdentityKey(friend.identityKey, chain)
    } catch {
      setHint('Could not resolve payment address.')
      playWalletSound('error')
      return
    }
    const resolved = resolveAmountSats(amount)
    if (!resolved.sats || resolved.sats <= 0) {
      setHint(
        amount.kind === 'fiat' && getCachedUsdPerBsv() == null
          ? 'USD rate unavailable — try 1 sat or BSV'
          : 'Amount too small — try 1 sat or more',
      )
      playWalletSound('error')
      return
    }
    appendMessage(friend.id, {
      direction: 'out',
      kind: 'pay-sent',
      text: `Pay ${resolved.amountLabel ?? amount.label}`,
      meta: {
        amountLabel: resolved.amountLabel ?? amount.label,
        sats: resolved.sats,
        to: address,
        friendLabel: friend.label,
        memo,
        payStatus: 'pending',
        status: 'Confirm to send',
      },
    })
    playWalletSound('soft')
  }

  const confirmPay = async (messageId: string) => {
    const msg = messages.find((m) => m.id === messageId)
    if (!msg || msg.meta?.payStatus !== 'pending') return
    const to = msg.meta?.to
    const sats = msg.meta?.sats
    if (!to || !sats || sats <= 0) {
      updateMessage(messageId, {
        meta: { payStatus: 'failed', status: 'Failed', error: 'Missing payment details' },
      })
      playWalletSound('error')
      return
    }

    updateMessage(messageId, {
      meta: { payStatus: 'sending', status: 'Sending…', error: undefined },
    })

    try {
      const { txid, balanceSats } = await sendSatsToAddress({
        to,
        satoshis: sats,
        friendLabel: msg.meta?.friendLabel,
        description: msg.meta?.memo
          ? `HandCash chat: ${msg.meta.memo}`
          : `HandCash chat pay to ${to}`,
      })
      updateMessage(messageId, {
        meta: {
          payStatus: 'sent',
          status: 'Sent',
          txid,
          error: undefined,
        },
      })
      playPaymentSuccessSound()
      onSent?.(balanceSats)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      updateMessage(messageId, {
        meta: { payStatus: 'failed', status: 'Failed', error },
      })
      playWalletSound('error')
    }
  }

  const cancelPay = (messageId: string) => {
    const msg = messages.find((m) => m.id === messageId)
    if (!msg || msg.meta?.payStatus !== 'pending') return
    updateMessage(messageId, {
      meta: { payStatus: 'cancelled', status: 'Cancelled' },
    })
    playWalletSound('soft')
  }

  const fillPaymentCommand = (verb: 'pay' | 'request') => {
    if (!activeFriend) return
    setHint(null)
    let cursor = 0
    setDraft((prev) => {
      const next = applyPaymentVerb(prev, verb)
      cursor = next.cursor
      return next.draft
    })
    playWalletSound('soft')
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(cursor, cursor)
    })
  }

  const onPay = () => fillPaymentCommand('pay')
  const onRequest = () => fillPaymentCommand('request')

  const onWhois = async () => {
    if (!activeFriend) return
    setHint(null)
    let address = ''
    try {
      address = addressFromIdentityKey(activeFriend.identityKey, chain)
    } catch {
      address = ''
    }
    const line = address || activeFriend.identityKey
    const ok = await copyText(line)
    appendMessage(activeFriend.id, {
      direction: 'system',
      kind: 'system',
      text: [
        activeFriend.label,
        activeFriend.identityKey,
        address ? address : null,
        ok ? 'Copied' : null,
      ]
        .filter(Boolean)
        .join('\n'),
    })
    playWalletSound(ok ? 'copy' : 'soft')
  }

  /** Plain chat; optional BRC-218 slash still works for power users, never advertised. */
  const sendText = (rawLine: string) => {
    const line = rawLine.trim()
    if (!line || !activePeerId || !activeFriend) return
    setHint(null)

    if (line.startsWith('//')) {
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
    if (cmd?.verb === 'pay' || cmd?.verb === 'tip') {
      const amount = 'amount' in cmd ? cmd.amount : undefined
      if (!amount) {
        setHint('Add an amount, e.g. /pay $0.01 or /pay 1 sat')
        playWalletSound('error')
        return
      }
      queuePay(activeFriend, amount, cmd.verb === 'pay' ? cmd.memo : undefined)
      setDraft('')
      return
    }
    if (cmd?.verb === 'request') {
      if (!cmd.amount) {
        setHint('Add an amount, e.g. /request $0.01 or /request 1 sat')
        playWalletSound('error')
        return
      }
      const resolved = resolveAmountSats(cmd.amount)
      appendMessage(activeFriend.id, {
        direction: 'out',
        kind: 'pay-request',
        text: cmd.memo || cmd.amount.label,
        meta: {
          amountLabel: resolved.amountLabel ?? cmd.amount.label,
          sats: resolved.sats,
          status: 'Request',
        },
      })
      playWalletSound('soft')
      setDraft('')
      return
    }
    if (cmd?.verb === 'whois') {
      void onWhois()
      setDraft('')
      return
    }
    if (cmd?.verb === 'message' && cmd.text.trim()) {
      appendMessage(activePeerId, { direction: 'out', kind: 'text', text: cmd.text.trim() })
      playWalletSound('soft')
      setDraft('')
      return
    }
    // Unsupported slash → send as plain text (never lecture)
    if (cmd?.verb === 'help' || cmd?.verb === 'unsupported') {
      appendMessage(activePeerId, { direction: 'out', kind: 'text', text: line })
      playWalletSound('soft')
      setDraft('')
      return
    }

    appendMessage(activePeerId, { direction: 'out', kind: 'text', text: line })
    playWalletSound('soft')
    setDraft('')
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    sendText(draft)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendText(draft)
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
        <ul className="chat-peer-list">
          {peers.length === 0 ? (
            <li className="chat-empty">No chats yet</li>
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
                        {thread?.lastPreview || ' '}
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
              {messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  msg={m}
                  onConfirmPay={(id) => void confirmPay(id)}
                  onCancelPay={cancelPay}
                />
              ))}
              <div ref={threadEndRef} />
            </div>

            {hint ? <p className="chat-hint">{hint}</p> : null}

            <form className="chat-composer" onSubmit={onSubmit}>
              <div className="chat-input-bar">
                <div className="chat-composer-actions" role="toolbar" aria-label="Chat actions">
                  <button
                    type="button"
                    className="chat-action-btn"
                    title="Pay"
                    aria-label="Pay"
                    onClick={onPay}
                  >
                    <PayIcon size={20} />
                  </button>
                  <button
                    type="button"
                    className="chat-action-btn"
                    title="Receive"
                    aria-label="Receive"
                    onClick={onRequest}
                  >
                    <RequestMoneyIcon size={20} />
                  </button>
                </div>
                <textarea
                  ref={inputRef}
                  className="chat-input"
                  rows={1}
                  placeholder="Message"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onKeyDown}
                  autoComplete="off"
                />
              </div>
              <button
                type="submit"
                className="btn btn-primary btn-icon"
                aria-label="Send"
                disabled={!draft.trim()}
              >
                <SendIcon size={18} />
              </button>
            </form>
          </>
        ) : (
          <div className="chat-placeholder">
            <p>Select a chat</p>
          </div>
        )}
      </section>
    </div>
  )
}
