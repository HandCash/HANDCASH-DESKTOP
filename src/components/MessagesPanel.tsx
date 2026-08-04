import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
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
  listMessagePeers,
  listMessages,
  markThreadRead,
  subscribeMessages,
  updateMessage,
  type ChatMessage,
} from '../wallet/messageStore'
import {
  COMMAND_PALETTE,
  formatFiatLabel,
  formatSatsLabel,
  helpText,
  matchingCommands,
  normalizeChatText,
  parseLocalCommand,
  type ParsedAmount,
} from '../wallet/brc218'
import { openAddFriend } from '../wallet/navStore'
import { amountToSats, getCachedUsdPerBsv } from '../wallet/fx'
import { getDisplayCurrency, type DisplayCurrency } from '../wallet/displayCurrency'
import { playWalletSound } from '../wallet/soundService'
import { playPaymentSuccessSound } from '../wallet/paymentSuccessSound'
import { sendSatsToAddress } from '../wallet/sendPayment'
import { subscribeMessageFocus, takeMessageFocus } from '../wallet/messageFocus'
import { copyText } from '../wallet/clipboard'
import { parseHandleInput, resolveHandle } from '../wallet/handleResolve'
import { deliverOutbound, pollInbound } from '../wallet/messageTransport'
import { EmptyState } from './EmptyState'
import {
  PayIcon,
  PersonAddIcon,
  RequestMoneyIcon,
  SendIcon,
} from './icons'

type Props = {
  chain: Chain
  identityKey?: string
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

function formatDay(ts: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(ts)
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
  if (sats < 1 && amount.value > 0 && usdPerBsv != null && usdPerBsv > 0) {
    sats = 1
  }
  const amountLabel = formatFiatLabel(amount.value, amount.currency)
  if (sats < 1) return { amountLabel }
  return { amountLabel, sats }
}

function defaultAmountLead(currency: DisplayCurrency): { text: string; cursor: number } {
  if (currency === 'usd') return { text: ' $', cursor: 2 }
  return { text: '  bsv', cursor: 1 }
}

function isUnitOnlyRest(rest: string): boolean {
  const t = rest.trim()
  return !t || t === '$' || /^bsv$/i.test(t)
}

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
  if (st === 'accepted') return 'Accepted'
  if (st === 'declined') return 'Declined'
  return msg.meta?.status ?? ''
}

function MessageBubble({
  msg,
  onConfirmPay,
  onCancelPay,
  onEscrowAccept,
  onEscrowDecline,
}: {
  msg: ChatMessage
  onConfirmPay?: (id: string) => void
  onCancelPay?: (id: string) => void
  onEscrowAccept?: (id: string) => void
  onEscrowDecline?: (id: string) => void
}) {
  if (msg.direction === 'system' || msg.kind === 'system' || msg.kind === 'whois') {
    return (
      <div className="chat-system" role="status">
        <pre>{msg.text}</pre>
      </div>
    )
  }

  const mine = msg.direction === 'out'
  const payStatus = msg.meta?.payStatus
  const canAct = msg.kind === 'pay-sent' && payStatus === 'pending'
  const canEscrow = msg.kind === 'escrow' && payStatus === 'pending'
  const isCard =
    msg.kind === 'pay-request' || msg.kind === 'pay-sent' || msg.kind === 'escrow'
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
          msg.kind === 'escrow' ? 'is-escrow' : '',
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
        ) : msg.kind === 'escrow' ? (
          <>
            <div className="chat-card-head">
              <span className="chat-card-badge">Escrow</span>
              {payStatus ? (
                <span className="chat-card-status" data-status={payStatus}>
                  {payStatusLabel(msg)}
                </span>
              ) : null}
            </div>
            <p className="chat-card-amount">{amountLabel}</p>
            {satsLine ? <p className="chat-card-sats">{satsLine}</p> : null}
            <p className="chat-card-meta">
              {msg.meta?.memo ||
                'Both sides in, awaiting the agent. Nothing moves until accept.'}
            </p>
            {canEscrow ? (
              <div className="chat-card-actions">
                <button
                  type="button"
                  className="chat-card-btn chat-card-btn-ghost"
                  onClick={() => onEscrowDecline?.(msg.id)}
                >
                  Decline
                </button>
                <button
                  type="button"
                  className="chat-card-btn chat-card-btn-primary"
                  onClick={() => onEscrowAccept?.(msg.id)}
                >
                  Accept and hold
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

export function MessagesPanel({ chain, identityKey, onSent }: Props) {
  const [peers, setPeers] = useState(() => listMessagePeers())
  const [activePeerId, setActivePeerId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [showCommands, setShowCommands] = useState(false)
  const threadEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const refresh = () => setPeers(listMessagePeers())

  useEffect(() => subscribeFriends(refresh), [])
  useEffect(() => subscribeMessages(refresh), [])

  useEffect(() => {
    return subscribeMessageFocus((peerId) => {
      if (!peerId) return
      setActivePeerId(peerId)
      takeMessageFocus()
    })
  }, [])

  useEffect(() => {
    if (!activePeerId) return
    markThreadRead(activePeerId)
    refresh()
  }, [activePeerId])

  useEffect(() => {
    if (!identityKey) return
    const friends = listFriends()
    const map = new Map(friends.map((f) => [f.identityKey.toLowerCase(), f.id]))
    const tick = () => {
      void pollInbound({
        identityKey,
        peerIdForSender: (ik) => map.get(ik.toLowerCase()) ?? null,
      }).then((n) => {
        if (n > 0) refresh()
      })
    }
    tick()
    const id = window.setInterval(tick, 20_000)
    return () => window.clearInterval(id)
  }, [identityKey])

  const activeFriend = activePeerId ? getFriendById(activePeerId) : null
  const messages = useMemo(
    () => (activePeerId ? listMessages(activePeerId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- peers tick refreshes store
    [activePeerId, peers],
  )

  const filteredPeers = useMemo(() => {
    const q = query.trim().toLowerCase()
    return peers.filter(({ friend, thread }) => {
      if (unreadOnly && !(thread?.unread && thread.unread > 0)) return false
      if (!q) return true
      const label = friend?.label?.toLowerCase() ?? ''
      const preview = thread?.lastPreview?.toLowerCase() ?? ''
      return label.includes(q) || preview.includes(q)
    })
  }, [peers, query, unreadOnly])

  const commandHints = useMemo(() => matchingCommands(draft), [draft])

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, activePeerId, peers])

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
          ? `HandCash messages: ${msg.meta.memo}`
          : `HandCash messages pay to ${to}`,
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

  const onEscrowAccept = (messageId: string) => {
    updateMessage(messageId, {
      meta: {
        payStatus: 'accepted',
        status: 'Accepted — agent hold (local stub until BRC-218 §5.21 custody)',
      },
    })
    playWalletSound('soft')
  }

  const onEscrowDecline = (messageId: string) => {
    updateMessage(messageId, {
      meta: { payStatus: 'declined', status: 'Declined' },
    })
    playWalletSound('soft')
  }

  const fillPaymentCommand = (verb: 'pay' | 'request') => {
    if (!activeFriend) return
    setHint(null)
    setShowCommands(false)
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

  const insertCommand = (verb: string) => {
    setShowCommands(false)
    setDraft(`/${verb} `)
    playWalletSound('soft')
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const onWhois = async (recipient?: string) => {
    if (!activeFriend && !recipient) return
    setHint(null)
    const target = recipient?.trim() || activeFriend?.label || ''
    if (parseHandleInput(target) || target.startsWith('@')) {
      try {
        const resolved = await resolveHandle(target.startsWith('@') ? target : `@${target}`)
        appendMessage(activePeerId || activeFriend!.id, {
          direction: 'system',
          kind: 'whois',
          text: [
            'Only you — not sent',
            resolved.display,
            resolved.identityKey,
            `domain: ${resolved.domain}`,
          ].join('\n'),
          meta: {
            handleDisplay: resolved.display,
            identityKey: resolved.identityKey,
          },
        })
        playWalletSound('soft')
        return
      } catch (err) {
        appendMessage(activePeerId || activeFriend!.id, {
          direction: 'system',
          kind: 'system',
          text: `Only you — not sent\n${err instanceof Error ? err.message : String(err)}`,
        })
        playWalletSound('error')
        return
      }
    }

    if (!activeFriend) return
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
      kind: 'whois',
      text: [
        'Only you — not sent',
        activeFriend.label,
        activeFriend.identityKey,
        address ? address : null,
        ok ? 'Copied receive address' : null,
      ]
        .filter(Boolean)
        .join('\n'),
      meta: { identityKey: activeFriend.identityKey },
    })
    playWalletSound(ok ? 'copy' : 'soft')
  }

  const sendPlain = async (peerId: string, friend: Friend, text: string) => {
    appendMessage(peerId, { direction: 'out', kind: 'text', text })
    if (identityKey) {
      void deliverOutbound({
        recipientIdentityKey: friend.identityKey,
        senderIdentityKey: identityKey,
        body: text,
        peerId,
      })
    }
    playWalletSound('soft')
  }

  const sendText = (rawLine: string) => {
    const line = rawLine.trim()
    if (!line || !activePeerId || !activeFriend) return
    setHint(null)
    setShowCommands(false)

    if (line.startsWith('//')) {
      void sendPlain(activePeerId, activeFriend, normalizeChatText(line))
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
    if (cmd?.verb === 'escrow') {
      if (!cmd.amount) {
        setHint('Add an amount, e.g. /escrow 1000 sats')
        playWalletSound('error')
        return
      }
      const resolved = resolveAmountSats(cmd.amount)
      appendMessage(activeFriend.id, {
        direction: 'out',
        kind: 'escrow',
        text: `Escrow ${resolved.amountLabel ?? cmd.amount.label}`,
        meta: {
          amountLabel: resolved.amountLabel ?? cmd.amount.label,
          sats: resolved.sats,
          memo: cmd.memo,
          escrowAsset: cmd.asset,
          payStatus: 'pending',
          status: 'Awaiting accept',
          commandRaw: line,
        },
      })
      playWalletSound('soft')
      setDraft('')
      return
    }
    if (cmd?.verb === 'whois') {
      void onWhois(cmd.recipient)
      setDraft('')
      return
    }
    if (cmd?.verb === 'help') {
      appendMessage(activePeerId, {
        direction: 'system',
        kind: 'system',
        text: helpText(),
      })
      playWalletSound('soft')
      setDraft('')
      return
    }
    if (cmd?.verb === 'message' && cmd.text.trim()) {
      void sendPlain(activePeerId, activeFriend, cmd.text.trim())
      setDraft('')
      return
    }
    if (
      cmd?.verb === 'sign' ||
      cmd?.verb === 'receipt' ||
      cmd?.verb === 'attest' ||
      cmd?.verb === 'scope' ||
      cmd?.verb === 'trolltoll'
    ) {
      appendMessage(activePeerId, {
        direction: 'system',
        kind: 'system',
        text: [
          'Only you — not sent',
          `/${cmd.verb} is recognized (BRC-218) but not fully wired yet.`,
          cmd.verb === 'scope' && 'value' in cmd && cmd.value
            ? `Requested scope: ${cmd.value}`
            : null,
          cmd.verb === 'trolltoll' && 'amount' in cmd && cmd.amount
            ? `Requested toll: ${cmd.amount.label}`
            : null,
        ]
          .filter(Boolean)
          .join('\n'),
        meta: { commandRaw: line },
      })
      playWalletSound('soft')
      setDraft('')
      return
    }
    if (cmd?.verb === 'unsupported') {
      appendMessage(activePeerId, {
        direction: 'system',
        kind: 'system',
        text: `Only you — not sent\n/${cmd.name} is not supported in this client.`,
      })
      playWalletSound('soft')
      setDraft('')
      return
    }

    void sendPlain(activePeerId, activeFriend, line)
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
    <div
      className="chat-shell"
      data-aeon-scope="messages"
      data-aeon-state={activePeerId ? 'thread' : 'list'}
    >
      <aside className="chat-sidebar">
        <div className="chat-sidebar-head">
          <h2>Messages</h2>
          <div className="chat-sidebar-tools">
            <label className="chat-unread-toggle" title="Unread only">
              <input
                type="checkbox"
                checked={unreadOnly}
                onChange={(e) => setUnreadOnly(e.target.checked)}
              />
              <span>Unread</span>
            </label>
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
        </div>
        <div className="chat-search">
          <input
            type="search"
            placeholder="Search conversations"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
        </div>
        <ul className="chat-peer-list">
          {filteredPeers.length === 0 ? (
            <li className="chat-empty">
              {peers.length === 0 ? 'No chats yet — add a friend' : 'No matches'}
            </li>
          ) : (
            filteredPeers.map(({ peerId, friend, thread }) => {
              const label = friend?.label ?? 'Unknown'
              const selected = activePeerId === peerId
              const unread = thread?.unread ?? 0
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
                      <strong>
                        {label}
                        {thread?.updatedAt ? (
                          <span className="chat-peer-when">{formatDay(thread.updatedAt)}</span>
                        ) : null}
                      </strong>
                      <span className="chat-peer-preview">{thread?.lastPreview || ' '}</span>
                    </span>
                    {unread > 0 ? (
                      <span className="chat-unread-badge" aria-label={`${unread} unread`}>
                        {unread > 9 ? '9+' : unread}
                      </span>
                    ) : null}
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
              <button
                type="button"
                className="chat-back-btn btn btn-ghost btn-icon"
                aria-label="Back to conversations"
                onClick={() => setActivePeerId(null)}
              >
                ←
              </button>
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
                <EmptyState
                  title="No messages yet"
                  body="Say hello, or use /pay and /request for in-thread payments."
                />
              ) : (
                messages.map((m) => (
                  <MessageBubble
                    key={m.id}
                    msg={m}
                    onConfirmPay={(id) => void confirmPay(id)}
                    onCancelPay={cancelPay}
                    onEscrowAccept={onEscrowAccept}
                    onEscrowDecline={onEscrowDecline}
                  />
                ))
              )}
              <div ref={threadEndRef} />
            </div>

            {hint ? <p className="chat-hint">{hint}</p> : null}

            {(showCommands || (draft.startsWith('/') && !draft.startsWith('//') && commandHints.length > 0)) && (
              <ul className="chat-command-menu" role="listbox" aria-label="Commands">
                {(showCommands ? COMMAND_PALETTE : commandHints).map((c) => (
                  <li key={c.verb}>
                    <button type="button" onClick={() => insertCommand(c.verb)}>
                      <code>/{c.verb}</code>
                      <span>{c.hint}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <form className="chat-composer" onSubmit={onSubmit}>
              <div className="chat-input-bar">
                <div className="chat-composer-actions" role="toolbar" aria-label="Message actions">
                  <button
                    type="button"
                    className="chat-action-btn"
                    title="Commands"
                    aria-label="Commands"
                    aria-expanded={showCommands}
                    onClick={() => {
                      setShowCommands((v) => !v)
                      if (!draft.startsWith('/')) setDraft('/')
                      playWalletSound('soft')
                      requestAnimationFrame(() => inputRef.current?.focus())
                    }}
                  >
                    /
                  </button>
                  <button
                    type="button"
                    className="chat-action-btn"
                    title="Pay"
                    aria-label="Pay"
                    onClick={() => fillPaymentCommand('pay')}
                  >
                    <PayIcon size={20} />
                  </button>
                  <button
                    type="button"
                    className="chat-action-btn"
                    title="Request"
                    aria-label="Request"
                    onClick={() => fillPaymentCommand('request')}
                  >
                    <RequestMoneyIcon size={20} />
                  </button>
                </div>
                <textarea
                  ref={inputRef}
                  className="chat-input"
                  rows={1}
                  placeholder={`Message ${activeFriend.label}`}
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value)
                    if (!e.target.value.startsWith('/')) setShowCommands(false)
                  }}
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
            <EmptyState
              title="Messages"
              body="Pick a friend to open a thread. Slash commands follow BRC-218."
              action={
                <button type="button" className="btn btn-primary" onClick={() => openAddFriend()}>
                  Add friend
                </button>
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
