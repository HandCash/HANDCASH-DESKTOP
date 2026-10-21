import {
  formatFiatLabel,
  formatSatsLabel,
  parseLocalCommand,
  type Brc218Command,
  type ParsedAmount,
} from '../../wallet/brc218'
import type { DisplayCurrency } from '../../wallet/displayCurrency'
import type { Friend } from '../../wallet/friends'
import { amountToSats, formatPrimaryFromSats } from '../../wallet/fx'
import type { ChatMessage, ChatThreadSection, listMessagePeers } from '../../wallet/messageStore'
import type { PaymentProgress } from '../../wallet/paymentProgress'
import { activityMatchesFriend, type ActivityEntry } from '../../wallet/appActivity'

export type ChatPeer = ReturnType<typeof listMessagePeers>[number]

/** Header of every system note the user sees in a thread but never sends. */
export const LOCAL_ONLY_NOTE = 'Only you — not sent'

export function localNote(...lines: string[]): string {
  return [LOCAL_ONLY_NOTE, ...lines].join('\n')
}

export function compactLines(lines: ReadonlyArray<string | null | undefined | false>): string[] {
  return lines.filter((line): line is string => Boolean(line))
}

export function formatTime(ts: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(ts)
  } catch {
    return ''
  }
}

export function formatDay(ts: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(ts)
  } catch {
    return ''
  }
}

export function formatActivityWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function shortenTxid(txid: string): string {
  if (txid.length <= 16) return txid
  return `${txid.slice(0, 8)}…${txid.slice(-6)}`
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(0.1, bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function unreadBadgeLabel(count: number): string {
  return count > 9 ? '9+' : String(count)
}

export function resolveAmountSats(
  amount: ParsedAmount | undefined,
  usdPerBsv: number | null,
): { amountLabel?: string; sats?: number } {
  if (!amount) return {}
  if (amount.kind === 'sats') {
    if (amount.sats < 1) return { amountLabel: amount.label }
    return { amountLabel: amount.label, sats: amount.sats }
  }
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

/** Turn the draft into `/pay` or `/request`, keeping any amount already typed. */
export function applyPaymentVerb(
  prev: string,
  verb: 'pay' | 'request',
  currency: DisplayCurrency,
): { draft: string; cursor: number } {
  const m = prev.trimStart().match(/^\/(pay|request)(\s[\s\S]*)?$/i)
  const rest = m?.[2] ?? ''
  if (m && !isUnitOnlyRest(rest)) {
    const draft = `/${verb}${rest.startsWith(' ') ? rest : ` ${rest}`}`
    return { draft, cursor: draft.length }
  }
  const lead = defaultAmountLead(currency)
  return { draft: `/${verb}${lead.text}`, cursor: `/${verb}`.length + lead.cursor }
}

/** A slash command, as opposed to plain text or a `//` escaped line. */
export function isCommandDraft(draft: string): boolean {
  return draft.startsWith('/') && !draft.startsWith('//')
}

export type ChatComposerState = 'idle' | 'chat' | 'command' | 'lookup'

export function composerStateFor(draft: string): ChatComposerState {
  if (isCommandDraft(draft)) {
    const cmd = parseLocalCommand(draft.trim())
    if (cmd?.verb === 'whois' || cmd?.verb === 'help') return 'lookup'
    return 'command'
  }
  if (draft.trim()) return 'chat'
  return 'idle'
}

export function filterPeers(
  peers: readonly ChatPeer[],
  query: string,
  unreadOnly: boolean,
): ChatPeer[] {
  const q = query.trim().toLowerCase()
  return peers.filter(({ friend, thread }) => {
    if (unreadOnly && !(thread?.unread && thread.unread > 0)) return false
    if (!q) return true
    const label = friend?.label?.toLowerCase() ?? ''
    const preview = thread?.lastPreview?.toLowerCase() ?? ''
    return label.includes(q) || preview.includes(q)
  })
}

/** Wallet activity with this friend that has no card in the chat already. */
export function peerActivityOutsideChat(
  entries: readonly ActivityEntry[],
  friend: Pick<Friend, 'identityKey' | 'label'>,
  messages: readonly ChatMessage[],
): ActivityEntry[] {
  const chatTxids = new Set(
    messages
      .map((m) => m.meta?.txid?.trim().toLowerCase())
      .filter((txid): txid is string => Boolean(txid)),
  )
  return entries
    .filter((entry) => activityMatchesFriend(entry, friend))
    .filter((entry) => !entry.txid || !chatTxids.has(entry.txid.trim().toLowerCase()))
}

export type PaymentTimelineRow =
  | { kind: 'message'; at: number; message: ChatMessage }
  | { kind: 'activity'; at: number; entry: ActivityEntry }

export function paymentTimeline(
  messages: readonly ChatMessage[],
  activity: readonly ActivityEntry[],
): PaymentTimelineRow[] {
  const rows: PaymentTimelineRow[] = [
    ...messages.map((message) => ({ kind: 'message' as const, at: message.createdAt, message })),
    ...activity.map((entry) => ({ kind: 'activity' as const, at: entry.at, entry })),
  ]
  rows.sort((a, b) => a.at - b.at)
  return rows
}

export type PayConfirmRequest = {
  id: string
  verb: string
  amountLabel: string
  satsLabel: string | null
}

export function payConfirmRequest(msg: ChatMessage): PayConfirmRequest {
  return {
    id: msg.id,
    verb: msg.kind === 'escrow' ? 'escrow' : msg.kind === 'tip' ? 'tip' : 'pay',
    amountLabel: msg.meta?.amountLabel ?? msg.text,
    satsLabel: msg.meta?.sats && msg.meta.sats > 0 ? formatSatsLabel(msg.meta.sats) : null,
  }
}

export function chatPaymentDescription(memo: string | undefined, payeeKey: string | null, to?: string): string {
  if (memo) return `HandCash messages: ${memo}`
  return payeeKey ? `HandCash messages BRC-29 pay` : `HandCash messages pay to ${to}`
}

export function payStatusLabel(msg: ChatMessage, payment: PaymentProgress): string {
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

/** The amount a card leads with, and the sats line under it when that adds anything. */
export function messageAmounts(
  msg: ChatMessage,
  currency: DisplayCurrency,
  usdPerBsv: number | null,
): { amountLabel: string; primaryAmount: string; satsLine: string | null } {
  const amountLabel = msg.meta?.amountLabel ?? msg.text
  const sats = msg.meta?.sats && msg.meta.sats > 0 ? msg.meta.sats : null
  const primaryFromSats = sats ? formatPrimaryFromSats(sats, currency, usdPerBsv) : null
  const primaryAmount = primaryFromSats && primaryFromSats !== '—' ? primaryFromSats : amountLabel
  const satsLine =
    sats && primaryAmount !== formatSatsLabel(sats) && !/\bsats?\b/i.test(primaryAmount)
      ? formatSatsLabel(sats)
      : null
  return { amountLabel, primaryAmount, satsLine }
}

export function isSystemMessage(msg: ChatMessage): boolean {
  return msg.direction === 'system' || msg.kind === 'system' || msg.kind === 'whois'
}

export function isPaymentCard(msg: ChatMessage): boolean {
  return msg.kind === 'pay-sent' || msg.kind === 'tip'
}

export function isCardMessage(msg: ChatMessage): boolean {
  return isPaymentCard(msg) || msg.kind === 'pay-request' || msg.kind === 'escrow'
}

export function messageItemState(msg: ChatMessage): string {
  const face =
    msg.kind === 'pay-request'
      ? 'request-card'
      : isPaymentCard(msg) || msg.kind === 'escrow'
        ? 'payment-card'
        : undefined
  return [
    msg.direction === 'out' ? 'mine' : 'theirs',
    face,
    msg.meta?.payStatus === 'failed' ? 'failed' : null,
  ]
    .filter(Boolean)
    .join(' ')
}

export function paymentBadge(kind: 'pay-sent' | 'tip', mine: boolean): string {
  if (kind === 'tip') return mine ? 'Tip sent' : 'Tip claimed'
  return mine ? 'Payment' : 'Payment claimed'
}

export function classNames(...names: ReadonlyArray<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ')
}

export function threadEmptyCopy(section: ChatThreadSection): { title: string; body: string } {
  if (section === 'files') {
    return { title: 'No shared files', body: 'Files shared in this conversation will appear here.' }
  }
  if (section === 'payments') {
    return {
      title: 'No payments yet',
      body: 'Payments and tips between you — including sends from the wallet — appear here.',
    }
  }
  return { title: 'No messages yet', body: 'Say hello, attach a file, or send an in-thread tip.' }
}

export type ChatShellState = 'list' | 'thread' | 'thread-only'

export function chatShellState(args: {
  navRouted: boolean
  threadOnly: boolean
  activePeerId: string | null
}): ChatShellState {
  if (!args.navRouted && args.threadOnly) return 'thread-only'
  return args.activePeerId ? 'thread' : 'list'
}

export function chatShellClass(nestedInNav: boolean, fullscreen: boolean): string {
  return classNames(
    'chat-shell',
    nestedInNav && 'chat-shell--nested chat-with-scroll',
    fullscreen && !nestedInNav && 'chat-shell--fullscreen',
  )
}

type UnwiredCommand = Extract<
  Brc218Command,
  { verb: 'sign' | 'receipt' | 'attest' | 'scope' | 'trolltoll' }
>

export function isUnwiredCommand(cmd: Brc218Command | null): cmd is UnwiredCommand {
  return (
    cmd?.verb === 'sign' ||
    cmd?.verb === 'receipt' ||
    cmd?.verb === 'attest' ||
    cmd?.verb === 'scope' ||
    cmd?.verb === 'trolltoll'
  )
}

export function unwiredCommandNote(cmd: UnwiredCommand): string {
  return localNote(
    ...compactLines([
      `/${cmd.verb} is recognized (BRC-218) but not fully wired yet.`,
      cmd.verb === 'scope' && cmd.value ? `Requested scope: ${cmd.value}` : null,
      cmd.verb === 'trolltoll' && cmd.amount ? `Requested toll: ${cmd.amount.label}` : null,
    ]),
  )
}
