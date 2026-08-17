import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
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
import { amountToSats, formatPrimaryFromSats, getCachedUsdPerBsv } from '../wallet/fx'
import { getDisplayCurrency, type DisplayCurrency } from '../wallet/displayCurrency'
import { playWalletSound } from '../wallet/soundService'
import { playPaymentSuccessSound } from '../wallet/paymentSuccessSound'
import { sendSatsToAddress } from '../wallet/sendPayment'
import { sendBrc29ToIdentityKey } from '../wallet/sendBrc29Payment'
import { getActiveWallet } from '../wallet/session'
import {
  getPaymentProgress,
  subscribePaymentProgress,
  type PaymentProgress,
} from '../wallet/paymentProgress'
import { subscribeMessageFocus, takeMessageFocus } from '../wallet/messageFocus'
import { copyText } from '../wallet/clipboard'
import { parseHandleInput, resolveHandle } from '../wallet/handleResolve'
import {
  deliverOutbound,
  encodeMessageBody,
  MAX_CHAT_FILE_BYTES,
  pollInbound,
  uploadChatFile,
} from '../wallet/messageTransport'
import { Composer, Thread } from '@aeon-ui/react'
import type { ComposerState } from '@aeon-ui/react'
import { CommandConfirmPrompt } from './CommandConfirmPrompt'
import { EmptyState } from './EmptyState'
import {
  AttachFileIcon,
  FileIcon,
  PayIcon,
  PersonAddIcon,
  RequestMoneyIcon,
  SendIcon,
} from './icons'

type Props = {
  chain: Chain
  identityKey?: string
  /** When set, open directly in this friend's thread (Friends → Message). */
  peerId?: string
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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(0.1, bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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

function payStatusLabel(msg: ChatMessage, payment: PaymentProgress): string {
  const st = msg.meta?.payStatus
  if (st === 'pending') return 'Confirm to send'
  if (st === 'sending') {
    return payment.phase !== 'idle' && payment.label ? payment.label : 'Sending…'
  }
  if (st === 'sent') {
    return msg.meta?.txid ? `Sent · ${shortenTxid(msg.meta.txid)}` : 'Sent'
  }
  if (st === 'failed') return msg.meta?.error ? `Failed · ${msg.meta.error}` : 'Failed'
  if (st === 'cancelled') return 'Cancelled'
  if (st === 'accepted') return 'Accepted'
  if (st === 'declined') return 'Declined'
  if (msg.direction === 'in' && (msg.kind === 'tip' || msg.kind === 'pay-sent')) {
    return msg.meta?.status
      ? msg.meta.status
      : msg.meta?.txid
        ? `Receiving (SPV) · ${shortenTxid(msg.meta.txid)}`
        : 'Receiving (SPV)'
  }
  return msg.meta?.status ?? ''
}

function MessageBubble({
  msg,
  peerLabel,
  onConfirmPay,
  onCancelPay,
  onEscrowAccept,
  onEscrowDecline,
  onBindReply,
}: {
  msg: ChatMessage
  peerLabel?: string
  onConfirmPay?: (id: string) => void
  onCancelPay?: (id: string) => void
  onEscrowAccept?: (id: string) => void
  onEscrowDecline?: (id: string) => void
  onBindReply?: (id: string) => void
}) {
  const [paymentProgress, setPaymentProgressState] = useState(() => getPaymentProgress())
  useEffect(() => {
    if (msg.meta?.payStatus !== 'sending') return
    return subscribePaymentProgress(setPaymentProgressState)
  }, [msg.meta?.payStatus])

  if (msg.direction === 'system' || msg.kind === 'system' || msg.kind === 'whois') {
    return (
      <Thread.Item state="command-result" className="chat-system" role="status">
        <Thread.Card data-aeon-part="command-result">
          <Thread.CardBody>
            <pre>{msg.text}</pre>
          </Thread.CardBody>
        </Thread.Card>
      </Thread.Item>
    )
  }

  const mine = msg.direction === 'out'
  const payStatus = msg.meta?.payStatus
  const canAct = (msg.kind === 'pay-sent' || msg.kind === 'tip') && payStatus === 'pending'
  const canEscrow = msg.kind === 'escrow' && payStatus === 'pending'
  const isCard =
    msg.kind === 'pay-request' ||
    msg.kind === 'pay-sent' ||
    msg.kind === 'tip' ||
    msg.kind === 'escrow'
  const amountLabel = msg.meta?.amountLabel ?? msg.text
  const displayCurrency = getDisplayCurrency()
  const primaryFromSats =
    msg.meta?.sats && msg.meta.sats > 0
      ? formatPrimaryFromSats(msg.meta.sats, displayCurrency, getCachedUsdPerBsv())
      : null
  const primaryAmount =
    primaryFromSats && primaryFromSats !== '—' ? primaryFromSats : amountLabel
  const satsLine =
    msg.meta?.sats &&
    msg.meta.sats > 0 &&
    primaryAmount !== formatSatsLabel(msg.meta.sats) &&
    !/\bsats?\b/i.test(primaryAmount)
      ? formatSatsLabel(msg.meta.sats)
      : null
  const label = peerLabel || 'Friend'
  const initial = label.trim().slice(0, 1).toUpperCase() || '?'
  const face =
    msg.kind === 'pay-request'
      ? 'request-card'
      : msg.kind === 'pay-sent' || msg.kind === 'tip' || msg.kind === 'escrow'
        ? 'payment-card'
        : undefined
  const itemState = [mine ? 'mine' : 'theirs', face, payStatus === 'failed' ? 'failed' : null]
    .filter(Boolean)
    .join(' ')

  return (
    <Thread.Item state={itemState} className={`chat-msg${mine ? ' is-mine' : ''}`}>
      {!mine ? (
        <span className="chat-msg-avatar" aria-hidden>
          {initial}
        </span>
      ) : null}
      <div className="chat-msg-stack">
        {!mine ? (
          <div className="chat-msg-meta">
            <button type="button" className="chat-msg-name">
              {label}
            </button>
            <span className="chat-msg-origin">HandCash</span>
            <time dateTime={new Date(msg.createdAt).toISOString()}>{formatTime(msg.createdAt)}</time>
          </div>
        ) : null}
        {isCard ? (
          <Thread.Card
            className={[
              'chat-bubble',
              'is-card',
              mine ? 'is-mine' : '',
              msg.kind === 'pay-sent' ? 'is-pay' : '',
              msg.kind === 'tip' ? 'is-tip' : '',
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
                <Thread.CardTitle className="chat-card-head">
                  <span className="chat-card-badge">Request</span>
                </Thread.CardTitle>
                <Thread.CardBody>
                  <p className="chat-card-amount">{amountLabel}</p>
                  {satsLine ? <p className="chat-card-sats">{satsLine}</p> : null}
                  {msg.meta?.status ? (
                    <span className="chat-card-meta">{msg.meta.status}</span>
                  ) : null}
                </Thread.CardBody>
              </>
            ) : msg.kind === 'pay-sent' || msg.kind === 'tip' ? (
              <>
                <Thread.CardTitle className="chat-card-head">
                  <span className="chat-card-badge">
                    {msg.kind === 'tip'
                      ? mine
                        ? 'Tip sent'
                        : 'Tip claimed'
                      : mine
                        ? 'Payment'
                        : 'Payment claimed'}
                  </span>
                  {(payStatus || (!mine && (msg.kind === 'tip' || msg.kind === 'pay-sent'))) ? (
                    <span
                      className="chat-card-status"
                      data-status={payStatus || 'claimed'}
                    >
                      {payStatusLabel(msg, paymentProgress)}
                    </span>
                  ) : null}
                </Thread.CardTitle>
                <Thread.CardBody className="chat-value-body">
                  <span className="chat-value-mark" aria-hidden>
                    <PayIcon size={20} />
                  </span>
                  <div>
                    <p className="chat-card-amount">{primaryAmount}</p>
                    {satsLine ? <p className="chat-card-sats">{satsLine}</p> : null}
                    {msg.meta?.memo ? <p className="chat-card-memo">{msg.meta.memo}</p> : null}
                    {msg.meta?.boundMessageId ? (
                      <p className="chat-card-memo">
                        Bound to {msg.meta.boundMessageId.slice(0, 8)}…
                      </p>
                    ) : null}
                  </div>
                </Thread.CardBody>
                {canAct ? (
                  <Thread.CardActions className="chat-card-actions">
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
                  </Thread.CardActions>
                ) : null}
              </>
            ) : (
              <>
                <Thread.CardTitle className="chat-card-head">
                  <span className="chat-card-badge">Escrow</span>
                  {payStatus ? (
                    <span className="chat-card-status" data-status={payStatus}>
                      {payStatusLabel(msg, paymentProgress)}
                    </span>
                  ) : null}
                </Thread.CardTitle>
                <Thread.CardBody>
                  <p className="chat-card-amount">{amountLabel}</p>
                  {satsLine ? <p className="chat-card-sats">{satsLine}</p> : null}
                  <p className="chat-card-meta">
                    {msg.meta?.memo ||
                      'Both sides in, awaiting the agent. Nothing moves until accept.'}
                  </p>
                </Thread.CardBody>
                {canEscrow ? (
                  <Thread.CardActions className="chat-card-actions">
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
                  </Thread.CardActions>
                ) : null}
              </>
            )}
            {mine ? (
              <time className="chat-bubble-time" dateTime={new Date(msg.createdAt).toISOString()}>
                {formatTime(msg.createdAt)}
              </time>
            ) : null}
          </Thread.Card>
        ) : msg.kind === 'file' && msg.meta?.attachment ? (
          <a
            className={['chat-bubble', 'chat-file-card', mine ? 'is-mine' : '']
              .filter(Boolean)
              .join(' ')}
            href={msg.meta.attachment.url}
            target="_blank"
            rel="noreferrer"
            download={msg.meta.attachment.name}
          >
            <span className="chat-file-icon" aria-hidden>
              <FileIcon size={22} />
            </span>
            <span className="chat-file-copy">
              <strong>{msg.meta.attachment.name}</strong>
              <span>
                {formatFileSize(msg.meta.attachment.size)} ·{' '}
                {mine ? 'Sent file' : 'Download file'}
              </span>
            </span>
            <time className="chat-bubble-time" dateTime={new Date(msg.createdAt).toISOString()}>
              {formatTime(msg.createdAt)}
            </time>
          </a>
        ) : (
          <Thread.Bubble
            className={['chat-bubble', mine ? 'is-mine' : ''].filter(Boolean).join(' ')}
            data-kind={msg.kind}
          >
            <p className="chat-bubble-text">{msg.text}</p>
            {mine ? (
              <time className="chat-bubble-time" dateTime={new Date(msg.createdAt).toISOString()}>
                {formatTime(msg.createdAt)}
              </time>
            ) : null}
          </Thread.Bubble>
        )}
        {!mine && onBindReply ? (
          <Thread.Bind
            className="chat-bind-btn"
            aria-label="Reply to bind tip"
            onClick={() => onBindReply(msg.id)}
          >
            Reply
          </Thread.Bind>
        ) : null}
      </div>
    </Thread.Item>
  )
}

export function MessagesPanel({ chain, identityKey, peerId, onSent }: Props) {
  const threadOnly = Boolean(peerId)
  const [peers, setPeers] = useState(() => listMessagePeers())
  const [activePeerId, setActivePeerId] = useState<string | null>(() => peerId ?? null)
  const [draft, setDraft] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [showCommands, setShowCommands] = useState(false)
  const [threadSection, setThreadSection] = useState<'messages' | 'files'>('messages')
  const [fileBusy, setFileBusy] = useState(false)
  const [boundMessageId, setBoundMessageId] = useState<string | null>(null)
  const [confirmCmd, setConfirmCmd] = useState<{
    id: string
    verb: string
    amountLabel: string
    satsLabel: string | null
  } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const threadEndRef = useRef<HTMLDivElement>(null)
  const threadListRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const refresh = () => setPeers(listMessagePeers())

  useEffect(() => {
    if (peerId) setActivePeerId(peerId)
  }, [peerId])

  useEffect(() => {
    setBoundMessageId(null)
    setThreadSection('messages')
  }, [activePeerId])

  useEffect(() => subscribeFriends(refresh), [])
  useEffect(() => subscribeMessages(refresh), [])

  useEffect(() => {
    if (threadOnly) return
    return subscribeMessageFocus((focused) => {
      if (!focused) return
      setActivePeerId(focused)
      takeMessageFocus()
    })
  }, [threadOnly])

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
      const rootKeyHex = getActiveWallet()?.rootKeyHex
      if (!rootKeyHex) return
      void pollInbound({
        identityKey,
        rootKeyHex,
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
  const visibleMessages = useMemo(
    () => (threadSection === 'files' ? messages.filter((m) => m.kind === 'file') : messages),
    [messages, threadSection],
  )
  const lastVisibleId = visibleMessages[visibleMessages.length - 1]?.id
  const lastVisibleDirection = visibleMessages[visibleMessages.length - 1]?.direction

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
  const composerState: ComposerState = useMemo(() => {
    if (draft.startsWith('/') && !draft.startsWith('//')) {
      const cmd = parseLocalCommand(draft.trim())
      if (cmd?.verb === 'whois' || cmd?.verb === 'help') return 'lookup'
      return 'command'
    }
    if (draft.trim()) return 'chat'
    return 'idle'
  }, [draft])

  useEffect(() => {
    stickToBottomRef.current = true
  }, [activePeerId])

  useEffect(() => {
    const list = threadListRef.current
    if (!list) return
    const onScroll = () => {
      const remaining = list.scrollHeight - list.scrollTop - list.clientHeight
      stickToBottomRef.current = remaining <= 48
    }
    onScroll()
    list.addEventListener('scroll', onScroll, { passive: true })
    return () => list.removeEventListener('scroll', onScroll)
  }, [activePeerId])

  useEffect(() => {
    const list = threadListRef.current
    if (!list || !activePeerId) return
    const forceFollow =
      lastVisibleDirection === 'out' || lastVisibleDirection === 'system'
    if (!stickToBottomRef.current && !forceFollow) return

    const pin = () => {
      list.scrollTop = list.scrollHeight
      threadEndRef.current?.scrollIntoView({ block: 'end', inline: 'nearest' })
      stickToBottomRef.current = true
    }
    pin()
    // Layout after images / card mount can grow the list one frame later.
    const raf = window.requestAnimationFrame(pin)
    return () => window.cancelAnimationFrame(raf)
  }, [visibleMessages.length, lastVisibleId, lastVisibleDirection, activePeerId, peers])

  const queuePay = (
    friend: Friend,
    amount: ParsedAmount,
    memo?: string,
    kind: 'pay-sent' | 'tip' = 'pay-sent',
    bindId?: string | null,
  ) => {
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
    let address = ''
    try {
      address = addressFromIdentityKey(friend.identityKey, chain)
    } catch {
      setHint('Could not resolve payment address.')
      playWalletSound('error')
      return
    }
    appendMessage(friend.id, {
      direction: 'out',
      kind,
      text: kind === 'tip' ? memo || 'Tip' : `Pay ${resolved.amountLabel ?? amount.label}`,
      meta: {
        amountLabel: resolved.amountLabel ?? amount.label,
        sats: resolved.sats,
        to: address,
        payeeIdentityKey: friend.identityKey,
        friendLabel: friend.label,
        memo,
        boundMessageId: kind === 'tip' ? bindId || undefined : undefined,
        payStatus: 'pending',
        status: 'Confirm to send',
      },
    })
    if (kind === 'tip') setBoundMessageId(null)
    playWalletSound('soft')
  }

  const confirmPay = async (messageId: string) => {
    const msg = messages.find((m) => m.id === messageId)
    if (!msg || msg.meta?.payStatus !== 'pending') return
    const payeeKey = msg.meta?.payeeIdentityKey?.trim() || null
    const to = msg.meta?.to
    const sats = msg.meta?.sats
    if ((!payeeKey && !to) || !sats || sats <= 0) {
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
      const description = msg.meta?.memo
        ? `HandCash messages: ${msg.meta.memo}`
        : payeeKey
          ? `HandCash messages BRC-29 pay`
          : `HandCash messages pay to ${to}`

      let txid: string
      let balanceSats: number
      let brc29:
        | {
            derivationPrefix: string
            derivationSuffix: string
            outputIndex: number
          }
        | undefined

      if (payeeKey) {
        const sent = await sendBrc29ToIdentityKey({
          payeeIdentityKey: payeeKey,
          satoshis: sats,
          friendLabel: msg.meta?.friendLabel,
          description,
        })
        txid = sent.txid
        balanceSats = sent.balanceSats
        brc29 = {
          derivationPrefix: sent.remittance.derivationPrefix,
          derivationSuffix: sent.remittance.derivationSuffix,
          outputIndex: sent.remittance.outputIndex ?? 0,
        }
      } else {
        const sent = await sendSatsToAddress({
          to: to!,
          satoshis: sats,
          friendLabel: msg.meta?.friendLabel,
          description,
        })
        txid = sent.txid
        balanceSats = sent.balanceSats
      }

      const sent = updateMessage(messageId, {
        meta: {
          payStatus: 'sent',
          status: 'Sent',
          txid,
          brc29,
          error: undefined,
        },
      })
      const recipient = getFriendById(msg.peerId)
      if (sent && recipient && identityKey) {
        const selfPay =
          recipient.identityKey.toLowerCase() === identityKey.toLowerCase()
        // BRC-29 already delivered the signed payment to the peer.
        if (!selfPay && !payeeKey) {
          const rootKeyHex = getActiveWallet()?.rootKeyHex
          if (!rootKeyHex) {
            setHint('Payment sent on-chain, but chat delivery needs an unlocked wallet.')
          } else {
            const delivered = await deliverOutbound({
              recipientIdentityKey: recipient.identityKey,
              senderIdentityKey: identityKey,
              rootKeyHex,
              body: encodeMessageBody(sent),
              peerId: msg.peerId,
              messagebox: recipient.messagebox,
            })
            if (delivered.delivered !== 'cloud') {
              setHint('Payment sent on-chain, but the chat card could not be delivered yet.')
            }
          }
        }
      }
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
    if (parseHandleInput(target) || target.startsWith('$') || target.startsWith('@')) {
      try {
        const resolved = await resolveHandle(
          /^(?:@\$|[$@])/.test(target) ? target : `$${target}`,
        )
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
    const rootKeyHex = getActiveWallet()?.rootKeyHex
    if (identityKey && rootKeyHex) {
      void deliverOutbound({
        recipientIdentityKey: friend.identityKey,
        senderIdentityKey: identityKey,
        rootKeyHex,
        body: text,
        peerId,
        messagebox: friend.messagebox,
      })
    }
    playWalletSound('soft')
  }

  const sendFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !activeFriend || !identityKey || fileBusy) return
    if (file.size > MAX_CHAT_FILE_BYTES) {
      setHint('Files are limited to 8 MB.')
      playWalletSound('error')
      return
    }

    setFileBusy(true)
    setHint(`Uploading ${file.name}…`)
    try {
      const rootKeyHex = getActiveWallet()?.rootKeyHex
      if (!rootKeyHex) throw new Error('Wallet locked')
      const attachment = await uploadChatFile({
        file,
        recipientIdentityKey: activeFriend.identityKey,
        senderIdentityKey: identityKey,
        rootKeyHex,
        messagebox: activeFriend.messagebox,
      })
      const outbound = {
        kind: 'file',
        text: attachment.name,
        meta: { attachment, status: 'Sent file' },
      } as const
      const delivered = await deliverOutbound({
        recipientIdentityKey: activeFriend.identityKey,
        senderIdentityKey: identityKey,
        rootKeyHex,
        body: encodeMessageBody(outbound),
        peerId: activeFriend.id,
        messagebox: activeFriend.messagebox,
      })
      if (delivered.delivered !== 'cloud') {
        throw new Error('File uploaded, but the message could not be delivered')
      }
      appendMessage(activeFriend.id, { direction: 'out', ...outbound })
      setHint(null)
      setThreadSection('messages')
      playWalletSound('soft')
    } catch (err) {
      setHint(err instanceof Error ? err.message : String(err))
      playWalletSound('error')
    } finally {
      setFileBusy(false)
    }
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
      queuePay(
        activeFriend,
        amount,
        cmd.verb === 'pay' ? cmd.memo : undefined,
        cmd.verb === 'tip' ? 'tip' : 'pay-sent',
        cmd.verb === 'tip' ? boundMessageId : null,
      )
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
      const request = appendMessage(activeFriend.id, {
        direction: 'out',
        kind: 'pay-request',
        text: cmd.memo || cmd.amount.label,
        meta: {
          amountLabel: resolved.amountLabel ?? cmd.amount.label,
          sats: resolved.sats,
          status: 'Request',
        },
      })
      if (identityKey) {
        const rootKeyHex = getActiveWallet()?.rootKeyHex
        if (rootKeyHex) {
          void deliverOutbound({
            recipientIdentityKey: activeFriend.identityKey,
            senderIdentityKey: identityKey,
            rootKeyHex,
            body: encodeMessageBody(request),
            peerId: activeFriend.id,
            messagebox: activeFriend.messagebox,
          })
        }
      }
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
      data-aeon-state={threadOnly ? 'thread-only' : activePeerId ? 'thread' : 'list'}
    >
      {!threadOnly ? (
      <aside className="chat-sidebar">
        <div className="chat-sidebar-head panel-label-bar">
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
            filteredPeers.map(({ peerId: id, friend, thread }) => {
              const label = friend?.label ?? 'Unknown'
              const selected = activePeerId === id
              const unreadCount = thread?.unread ?? 0
              return (
                <li key={id}>
                  <button
                    type="button"
                    className="chat-peer-row"
                    data-selected={selected ? '' : undefined}
                    onClick={() => setActivePeerId(id)}
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
                    {unreadCount > 0 ? (
                      <span className="chat-unread-badge" aria-label={`${unreadCount} unread`}>
                        {unreadCount > 9 ? '9+' : unreadCount}
                      </span>
                    ) : null}
                  </button>
                </li>
              )
            })
          )}
        </ul>
      </aside>
      ) : null}

      <section className="chat-thread">
        {activeFriend ? (
          <>
            <header className="chat-thread-head panel-label-bar">
              {!threadOnly ? (
                <button
                  type="button"
                  className="chat-back-btn btn btn-ghost btn-icon"
                  aria-label="Back to conversations"
                  onClick={() => setActivePeerId(null)}
                >
                  ←
                </button>
              ) : null}
              <span className="friend-avatar chat-thread-avatar" aria-hidden>
                {friendInitial(activeFriend.label)}
              </span>
              <div className="chat-thread-titles">
                <strong>{activeFriend.label}</strong>
                <span className="chat-thread-sub">1:1 · Message · Tip · Pay · Files</span>
              </div>
            </header>
            <nav className="chat-thread-tabs panel-label-bar" aria-label="Thread sections">
              <button
                type="button"
                className="chat-thread-tab"
                data-active={threadSection === 'messages' ? '' : undefined}
                aria-current={threadSection === 'messages' ? 'page' : undefined}
                onClick={() => setThreadSection('messages')}
              >
                Messages
              </button>
              <button
                type="button"
                className="chat-thread-tab"
                data-active={threadSection === 'files' ? '' : undefined}
                aria-current={threadSection === 'files' ? 'page' : undefined}
                onClick={() => setThreadSection('files')}
              >
                Files
              </button>
              <button type="button" className="chat-thread-tab" disabled title="Coming soon">
                Notes
              </button>
            </nav>

            <Thread.Root className="chat-thread-messages">
              <Thread.List ref={threadListRef} className="chat-thread-list">
                {visibleMessages.length === 0 ? (
                  <EmptyState
                    title={threadSection === 'files' ? 'No shared files' : 'No messages yet'}
                    body={
                      threadSection === 'files'
                        ? 'Files shared in this conversation will appear here.'
                        : 'Say hello, attach a file, or send an in-thread tip.'
                    }
                  />
                ) : (
                  visibleMessages.map((m) => (
                    <MessageBubble
                      key={m.id}
                      msg={m}
                      peerLabel={activeFriend.label}
                      onConfirmPay={(id) => {
                        const m = messages.find((x) => x.id === id)
                        if (!m) return
                        setConfirmCmd({
                          id,
                          verb: m.kind === 'escrow' ? 'escrow' : m.kind === 'tip' ? 'tip' : 'pay',
                          amountLabel: m.meta?.amountLabel ?? m.text,
                          satsLabel:
                            m.meta?.sats && m.meta.sats > 0
                              ? formatSatsLabel(m.meta.sats)
                              : null,
                        })
                      }}
                      onCancelPay={cancelPay}
                      onEscrowAccept={onEscrowAccept}
                      onEscrowDecline={onEscrowDecline}
                      onBindReply={(id) => {
                        setBoundMessageId(id)
                        setDraft('/tip ')
                        setHint(`Bound tip to message ${id.slice(0, 8)}…`)
                        playWalletSound('soft')
                        requestAnimationFrame(() => inputRef.current?.focus())
                      }}
                    />
                  ))
                )}
                <div ref={threadEndRef} />
              </Thread.List>
            </Thread.Root>

            {hint ? <p className="chat-hint">{hint}</p> : null}

            <Composer.Root
              className="chat-composer"
              state={composerState}
              onSubmit={onSubmit}
              data-aeon-part="brc218-composer"
            >
              {(showCommands ||
                (draft.startsWith('/') && !draft.startsWith('//') && commandHints.length > 0)) && (
                <Composer.Suggestions className="chat-command-menu" aria-label="Commands">
                  {(showCommands ? COMMAND_PALETTE : commandHints).map((c) => (
                    <li key={c.verb}>
                      <Composer.Suggestion onClick={() => insertCommand(c.verb)}>
                        <code>/{c.verb}</code>
                        <span>{c.hint}</span>
                      </Composer.Suggestion>
                    </li>
                  ))}
                </Composer.Suggestions>
              )}

              <Composer.Toolbar className="chat-composer-toolbar">
                <input
                  ref={fileInputRef}
                  className="chat-file-input"
                  type="file"
                  tabIndex={-1}
                  aria-hidden
                  onChange={(event) => void sendFile(event)}
                />
                <button
                  type="button"
                  className="chat-action-btn"
                  title="Attach file (up to 8 MB)"
                  aria-label="Attach file"
                  disabled={fileBusy || !identityKey}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <AttachFileIcon size={18} />
                </button>
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
                  <PayIcon size={18} />
                </button>
                <button
                  type="button"
                  className="chat-action-btn"
                  title="Request"
                  aria-label="Request"
                  onClick={() => fillPaymentCommand('request')}
                >
                  <RequestMoneyIcon size={18} />
                </button>
              </Composer.Toolbar>

              <Composer.Input
                ref={inputRef}
                className="chat-input"
                placeholder={`Message ${activeFriend.label}`}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value)
                  if (!e.target.value.startsWith('/')) setShowCommands(false)
                }}
                onKeyDown={onKeyDown}
                autoComplete="off"
              />
              <Composer.Actions>
                <Composer.Send>
                  <button
                    type="submit"
                    className="chat-send-btn"
                    aria-label="Send"
                    disabled={!draft.trim()}
                  >
                    <SendIcon size={18} />
                  </button>
                </Composer.Send>
              </Composer.Actions>
            </Composer.Root>

            <CommandConfirmPrompt
              open={Boolean(confirmCmd)}
              verb={confirmCmd?.verb ?? 'pay'}
              recipient={`@${activeFriend.label.replace(/^@\$|^[$@]/, '')}@handcash.io`}
              amountLabel={confirmCmd?.amountLabel ?? ''}
              satsLabel={confirmCmd?.satsLabel}
              effect={`Send ${confirmCmd?.amountLabel ?? 'this amount'} to ${activeFriend.label}. This moves value and cannot be undone.`}
              confirming={confirming}
              onCancel={() => {
                setConfirmCmd(null)
                setConfirming(false)
              }}
              onConfirm={() => {
                if (!confirmCmd) return
                setConfirming(true)
                void confirmPay(confirmCmd.id).finally(() => {
                  setConfirming(false)
                  setConfirmCmd(null)
                })
              }}
            />
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
