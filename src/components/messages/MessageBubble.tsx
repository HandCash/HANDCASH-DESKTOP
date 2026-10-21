import { useEffect, useState } from 'react'
import { Thread } from '@aeon-ui/react'
import {
  classNames,
  formatFileSize,
  formatTime,
  isCardMessage,
  isPaymentCard,
  isSystemMessage,
  messageAmounts,
  messageItemState,
  paymentBadge,
  payStatusLabel,
  peerInitial,
  type ChatMessage,
} from '../../features/messages'
import { getDisplayCurrency } from '../../wallet/displayCurrency'
import { getCachedUsdPerBsv } from '../../wallet/fx'
import {
  getPaymentProgress,
  subscribePaymentProgress,
  type PaymentProgress,
} from '../../wallet/paymentProgress'
import { FileIcon, PayIcon } from '../icons'

export type MessageActions = {
  onConfirmPay?: (id: string) => void
  onCancelPay?: (id: string) => void
  onEscrowAccept?: (id: string) => void
  onEscrowDecline?: (id: string) => void
  onBindReply?: (id: string) => void
}

type CardProps = {
  msg: ChatMessage
  mine: boolean
  amounts: ReturnType<typeof messageAmounts>
  paymentProgress: PaymentProgress
  actions: MessageActions
}

function MessageTime({ at, className }: { at: number; className?: string }) {
  return (
    <time className={className} dateTime={new Date(at).toISOString()}>
      {formatTime(at)}
    </time>
  )
}

function BubbleTime({ at }: { at: number }) {
  return <MessageTime at={at} className="chat-bubble-time" />
}

function CardButtons({
  cancel,
  confirm,
}: {
  cancel: { label: string; onClick: () => void }
  confirm: { label: string; onClick: () => void }
}) {
  return (
    <Thread.CardActions className="chat-card-actions">
      <button type="button" className="chat-card-btn chat-card-btn-ghost" onClick={cancel.onClick}>
        {cancel.label}
      </button>
      <button type="button" className="chat-card-btn chat-card-btn-primary" onClick={confirm.onClick}>
        {confirm.label}
      </button>
    </Thread.CardActions>
  )
}

function SatsLine({ satsLine }: { satsLine: string | null }) {
  return satsLine ? <p className="chat-card-sats">{satsLine}</p> : null
}

function RequestCard({ msg, amounts }: CardProps) {
  return (
    <>
      <Thread.CardTitle className="chat-card-head">
        <span className="chat-card-badge">Request</span>
      </Thread.CardTitle>
      <Thread.CardBody>
        <p className="chat-card-amount">{amounts.amountLabel}</p>
        <SatsLine satsLine={amounts.satsLine} />
        {msg.meta?.status ? <span className="chat-card-meta">{msg.meta.status}</span> : null}
      </Thread.CardBody>
    </>
  )
}

function PaymentCard({ msg, mine, amounts, paymentProgress, actions }: CardProps) {
  const payStatus = msg.meta?.payStatus
  const kind = msg.kind === 'tip' ? 'tip' : 'pay-sent'
  return (
    <>
      <Thread.CardTitle className="chat-card-head">
        <span className="chat-card-badge">{paymentBadge(kind, mine)}</span>
        {payStatus || !mine ? (
          <span className="chat-card-status" data-status={payStatus || 'claimed'}>
            {payStatusLabel(msg, paymentProgress)}
          </span>
        ) : null}
      </Thread.CardTitle>
      <Thread.CardBody className="chat-value-body">
        <span className="chat-value-mark" aria-hidden>
          <PayIcon size={20} />
        </span>
        <div>
          <p className="chat-card-amount">{amounts.primaryAmount}</p>
          <SatsLine satsLine={amounts.satsLine} />
          {msg.meta?.memo ? <p className="chat-card-memo">{msg.meta.memo}</p> : null}
          {msg.meta?.boundMessageId ? (
            <p className="chat-card-memo">Bound to {msg.meta.boundMessageId.slice(0, 8)}…</p>
          ) : null}
        </div>
      </Thread.CardBody>
      {payStatus === 'pending' ? (
        <CardButtons
          cancel={{ label: 'Cancel', onClick: () => actions.onCancelPay?.(msg.id) }}
          confirm={{ label: 'Confirm', onClick: () => actions.onConfirmPay?.(msg.id) }}
        />
      ) : null}
    </>
  )
}

function EscrowCard({ msg, amounts, paymentProgress, actions }: CardProps) {
  const payStatus = msg.meta?.payStatus
  return (
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
        <p className="chat-card-amount">{amounts.amountLabel}</p>
        <SatsLine satsLine={amounts.satsLine} />
        <p className="chat-card-meta">
          {msg.meta?.memo || 'Both sides in, awaiting the agent. Nothing moves until accept.'}
        </p>
      </Thread.CardBody>
      {payStatus === 'pending' ? (
        <CardButtons
          cancel={{ label: 'Decline', onClick: () => actions.onEscrowDecline?.(msg.id) }}
          confirm={{ label: 'Accept and hold', onClick: () => actions.onEscrowAccept?.(msg.id) }}
        />
      ) : null}
    </>
  )
}

function ValueCard(props: CardProps) {
  const { msg, mine } = props
  return (
    <Thread.Card
      className={classNames(
        'chat-bubble',
        'is-card',
        mine && 'is-mine',
        msg.kind === 'pay-sent' && 'is-pay',
        msg.kind === 'tip' && 'is-tip',
        msg.kind === 'pay-request' && 'is-request',
        msg.kind === 'escrow' && 'is-escrow',
      )}
      data-kind={msg.kind}
      data-pay-status={msg.meta?.payStatus || undefined}
    >
      {msg.kind === 'pay-request' ? (
        <RequestCard {...props} />
      ) : isPaymentCard(msg) ? (
        <PaymentCard {...props} />
      ) : (
        <EscrowCard {...props} />
      )}
      {mine ? <BubbleTime at={msg.createdAt} /> : null}
    </Thread.Card>
  )
}

function FileCard({ msg, mine }: { msg: ChatMessage; mine: boolean }) {
  const attachment = msg.meta!.attachment!
  return (
    <a
      className={classNames('chat-bubble', 'chat-file-card', mine && 'is-mine')}
      href={attachment.url}
      target="_blank"
      rel="noreferrer"
      download={attachment.name}
    >
      <span className="chat-file-icon" aria-hidden>
        <FileIcon size={22} />
      </span>
      <span className="chat-file-copy">
        <strong>{attachment.name}</strong>
        <span>
          {formatFileSize(attachment.size)} · {mine ? 'Sent file' : 'Download file'}
        </span>
      </span>
      <BubbleTime at={msg.createdAt} />
    </a>
  )
}

function TextBubble({ msg, mine }: { msg: ChatMessage; mine: boolean }) {
  return (
    <Thread.Bubble className={classNames('chat-bubble', mine && 'is-mine')} data-kind={msg.kind}>
      <p className="chat-bubble-text">{msg.text}</p>
      {mine ? <BubbleTime at={msg.createdAt} /> : null}
    </Thread.Bubble>
  )
}

function SystemNote({ msg }: { msg: ChatMessage }) {
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

function usePaymentProgressWhileSending(msg: ChatMessage): PaymentProgress {
  const [paymentProgress, setPaymentProgress] = useState(() => getPaymentProgress())
  useEffect(() => {
    if (msg.meta?.payStatus !== 'sending') return
    return subscribePaymentProgress(setPaymentProgress)
  }, [msg.meta?.payStatus])
  return paymentProgress
}

export function MessageBubble({
  msg,
  peerLabel,
  ...actions
}: { msg: ChatMessage; peerLabel?: string } & MessageActions) {
  const paymentProgress = usePaymentProgressWhileSending(msg)

  if (isSystemMessage(msg)) return <SystemNote msg={msg} />

  const mine = msg.direction === 'out'
  const label = peerLabel || 'Friend'
  const amounts = messageAmounts(msg, getDisplayCurrency(), getCachedUsdPerBsv())

  return (
    <Thread.Item state={messageItemState(msg)} className={`chat-msg${mine ? ' is-mine' : ''}`}>
      {!mine ? (
        <span className="chat-msg-avatar" aria-hidden>
          {peerInitial(label)}
        </span>
      ) : null}
      <div className="chat-msg-stack">
        {!mine ? (
          <div className="chat-msg-meta">
            <button type="button" className="chat-msg-name">
              {label}
            </button>
            <span className="chat-msg-origin">HandCash</span>
            <MessageTime at={msg.createdAt} />
          </div>
        ) : null}
        {isCardMessage(msg) ? (
          <ValueCard msg={msg} mine={mine} amounts={amounts} paymentProgress={paymentProgress} actions={actions} />
        ) : msg.kind === 'file' && msg.meta?.attachment ? (
          <FileCard msg={msg} mine={mine} />
        ) : (
          <TextBubble msg={msg} mine={mine} />
        )}
        {!mine && actions.onBindReply ? (
          <Thread.Bind
            className="chat-bind-btn"
            aria-label="Reply to bind tip"
            onClick={() => actions.onBindReply?.(msg.id)}
          >
            Reply
          </Thread.Bind>
        ) : null}
      </div>
    </Thread.Item>
  )
}
