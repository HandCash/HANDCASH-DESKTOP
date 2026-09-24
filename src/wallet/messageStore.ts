/**
 * Local-first Messages store (BRC-169 delivery + BRC-218 cards).
 * Persists across sessions; cloud sync is additive via messageTransport.
 */
import { accountLocalKey, peekAccountLocalKeyScope } from './accountLocalKeys'
import { durableGetItem, durableSetItem } from './durableStorage'
import { storageRegistry } from '../storage/registry'
import { listFriends, type Friend } from './friends'

const STORAGE_KEY_BASE = storageRegistry.messages.key
const LEGACY_KEY = storageRegistry.legacyChat.key

function messagesStorageKey(): string {
  return accountLocalKey(STORAGE_KEY_BASE)
}

export type MessagePayStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'cancelled'
  | 'accepted'
  | 'declined'

export type MessageKind =
  | 'text'
  | 'system'
  | 'command'
  | 'pay-request'
  | 'pay-sent'
  | 'tip'
  | 'file'
  | 'escrow'
  | 'whois'

export type ChatAttachment = {
  id: string
  name: string
  contentType: string
  size: number
  url: string
  expiresAt?: number
}

/** Asset carried by an item-settle message. Absent means legacy collectable. */
export type ItemTransferAsset =
  | { kind: 'collectable' }
  | {
      kind: 'fungible'
      tokenId: string
      amount: string
      sym: string
      dec: number
      icon?: string
      issuer?: string
    }

/** One collectable output in a multi-item transaction. */
export type ItemTransferMember = {
  outputIndex: number
  name: string
  origin: string
  collectionId?: string
  provenance?: {
    v: 2
    origin: string
    tip: string
    path: string[]
    beefB64: string
    contentType?: string
  }
}

export type ChatMessage = {
  id: string
  peerId: string
  direction: 'out' | 'in' | 'system'
  kind: MessageKind
  text: string
  createdAt: number
  readAt?: number
  meta?: {
    amountLabel?: string
    sats?: number
    status?: string
    payStatus?: MessagePayStatus
    to?: string
    /** Payee identity key when this card is a BRC-29 peer payment. */
    payeeIdentityKey?: string
    friendLabel?: string
    memo?: string
    txid?: string
    error?: string
    commandRaw?: string
    boundMessageId?: string
    handleDisplay?: string
    identityKey?: string
    messagebox?: string | null
    escrowAsset?: string
    origin?: string
    attachment?: ChatAttachment
    /** BRC-29 remittance for peer tip/pay-sent (prefix/suffix + output index). */
    brc29?: {
      derivationPrefix: string
      derivationSuffix: string
      outputIndex?: number
    }
    /** Optional item/token metadata notification with inline Atomic BEEF. */
    item?: boolean
    itemOrigin?: string
    itemCollectionId?: string
    /** Exact transaction output this item card describes. */
    itemOutputIndex?: number
    /** Tagged asset grammar; absent on older collectable messages. */
    asset?: ItemTransferAsset
    /** Per-output identity for a collectable batch sharing one txid. */
    items?: ItemTransferMember[]
    /** BRC-150 remittance from the sender — verify this hop without an indexer. */
    provenance?: {
      v: 2
      origin: string
      tip: string
      path: string[]
      beefB64: string
      contentType?: string
    }
    /** Intentional in-thread pay/tip card — not a silent Send-panel notify. */
    chatRef?: boolean
  }
}

const PAYMENT_KINDS = new Set<MessageKind>(['pay-sent', 'tip', 'pay-request', 'escrow'])

/** Settled / in-flight money cards — not pay-request prompts. */
const PAYMENTS_TAB_KINDS = new Set<MessageKind>(['pay-sent', 'tip', 'escrow'])

export function isPaymentMessageKind(kind: MessageKind): boolean {
  return PAYMENT_KINDS.has(kind)
}

export function isPaymentsTabMessageKind(kind: MessageKind): boolean {
  return PAYMENTS_TAB_KINDS.has(kind)
}

/** Pay/tip cards the user composed in chat (vs protocol notify from Send). */
export function isChatReferencedPayment(msg: Pick<ChatMessage, 'kind' | 'meta'>): boolean {
  return (msg.kind === 'pay-sent' || msg.kind === 'tip') && msg.meta?.chatRef === true
}

export type ChatThreadSection = 'messages' | 'files' | 'payments'

export function messageBelongsInThreadSection(
  msg: ChatMessage,
  section: ChatThreadSection,
): boolean {
  if (section === 'files') return msg.kind === 'file'
  if (section === 'payments') return isPaymentsTabMessageKind(msg.kind)
  if (msg.kind === 'pay-sent' || msg.kind === 'tip') return isChatReferencedPayment(msg)
  if (msg.kind === 'escrow') return false
  return true
}

function threadPreviewEligible(msg: ChatMessage): boolean {
  if (msg.kind === 'pay-sent' || msg.kind === 'tip') return isChatReferencedPayment(msg)
  return true
}

export type ChatThread = {
  peerId: string
  updatedAt: number
  lastPreview: string
  unread: number
}

type ChatState = {
  messages: ChatMessage[]
}

/**
 * Messages are local conversation history, not the messagebox ACK/custody
 * queue. Bound their share of the mobile WebView's 5MB origin store; inline
 * Atomic BEEF/provenance can otherwise make a handful of old item cards crowd
 * out signed-cheque and miner-retry state.
 */
export const MESSAGES_DURABLE_MAX_BYTES = 768 * 1024
const MESSAGES_DURABLE_MAX_ENTRIES = 2000

function encodeMessages(messages: ChatMessage[]): string {
  return JSON.stringify({
    v: storageRegistry.messages.version,
    data: { messages },
  })
}

/**
 * Serialize history, dropping the oldest entries only when the blob would
 * exceed the budget.
 *
 * The whole list is encoded once up front and returned as-is when it fits.
 * Deciding *how much* to drop re-encodes on every probe of the search below,
 * so running that unconditionally charged every read and write a `log2(n)`
 * multiple of a JSON.stringify over history that is allowed to reach 768KB.
 * Trimming is the rare case; it alone should pay for the search.
 */
function compactMessages(state: ChatState): {
  state: ChatState
  body: string
  dropped: number
} {
  const full = encodeMessages(state.messages)
  if (
    full.length <= MESSAGES_DURABLE_MAX_BYTES &&
    state.messages.length <= MESSAGES_DURABLE_MAX_ENTRIES
  ) {
    return { state, body: full, dropped: 0 }
  }

  const newest = state.messages
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MESSAGES_DURABLE_MAX_ENTRIES)
  const encode = (count: number) => {
    const messages = newest
      .slice(0, count)
      .sort((a, b) => a.createdAt - b.createdAt)
    return { state: { messages }, body: encodeMessages(messages) }
  }

  let low = newest.length > 0 ? 1 : 0
  let high = newest.length
  let best = encode(low)
  while (low <= high) {
    const count = Math.floor((low + high) / 2)
    const candidate = encode(count)
    if (candidate.body.length <= MESSAGES_DURABLE_MAX_BYTES || count === 1) {
      best = candidate
      low = count + 1
    } else {
      high = count - 1
    }
  }
  return {
    ...best,
    dropped: state.messages.length - best.state.messages.length,
  }
}

type Listener = () => void

const listeners = new Set<Listener>()
let messageWriteGeneration = 0

function notify() {
  for (const l of listeners) l()
}

function migrateLegacy(): ChatState | null {
  // Legacy chat blob belongs to the primary account only.
  if (peekAccountLocalKeyScope().accountIndex !== 0) return null
  try {
    const raw = durableGetItem(LEGACY_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ChatState
    if (!parsed || !Array.isArray(parsed.messages)) return null
    durableSetItem(
      messagesStorageKey(),
      JSON.stringify({ v: storageRegistry.messages.version, data: parsed }),
    )
    return parsed
  } catch {
    return null
  }
}

/**
 * Parsed history, keyed on the exact blob it came from. `durableGetItem` is an
 * in-memory lookup; the cost worth avoiding is the `JSON.parse` behind it, and
 * callers that walk every thread pay it repeatedly — `markInboundPaymentStatus`
 * on the chain-ingest path reads history once per thread. Keying on the raw
 * string rather than a write counter means anything that changes the store,
 * including paths outside this module, invalidates it.
 */
let readCache: { key: string; raw: string | null; state: ChatState } | null =
  null

function readState(): ChatState {
  const key = messagesStorageKey()
  const raw = durableGetItem(key)
  const cached = readCache
  if (cached && cached.key === key && cached.raw === raw) return cached.state
  const state = parseState(key, raw)
  readCache = { key, raw, state }
  return state
}

function parseState(key: string, raw: string | null): ChatState {
  try {
    if (!raw) {
      const legacy = migrateLegacy()
      if (legacy) return legacy
      return { messages: [] }
    }
    const decoded = JSON.parse(raw) as unknown
    const record =
      decoded && typeof decoded === 'object'
        ? (decoded as Record<string, unknown>)
        : null
    const parsed =
      record?.v === storageRegistry.messages.version &&
      record.data &&
      typeof record.data === 'object'
        ? (record.data as ChatState)
        : (decoded as ChatState)
    if (!parsed || !Array.isArray(parsed.messages)) return { messages: [] }
    // The stored blob is its own size check, so history that is already in
    // budget needs no re-encode to prove it.
    if (
      raw.length <= MESSAGES_DURABLE_MAX_BYTES &&
      parsed.messages.length <= MESSAGES_DURABLE_MAX_ENTRIES
    ) {
      return { messages: parsed.messages }
    }
    const compacted = compactMessages({ messages: parsed.messages })
    if (compacted.dropped > 0) {
      durableSetItem(key, compacted.body)
      console.info(
        `[messages] dropped ${compacted.dropped} oldest message(s) to keep durable history under ${Math.round(
          MESSAGES_DURABLE_MAX_BYTES / 1024,
        )}KB`,
      )
    }
    return compacted.state
  } catch {
    return { messages: [] }
  }
}

function writeState(state: ChatState) {
  const key = messagesStorageKey()
  const compacted = compactMessages(state)
  durableSetItem(key, compacted.body)
  if (compacted.dropped > 0) {
    console.info(
      `[messages] dropped ${compacted.dropped} oldest message(s) to keep durable history under ${Math.round(
        MESSAGES_DURABLE_MAX_BYTES / 1024,
      )}KB`,
    )
  }
  messageWriteGeneration += 1
  readCache = { key, raw: compacted.body, state: compacted.state }
  notify()
}

export function rebindMessagesForAccount(): void {
  messageWriteGeneration += 1
  notify()
}

/** Cheap cache key for derived chat indexes; changes only when messages do. */
export function getMessageWriteGeneration(): number {
  return messageWriteGeneration
}

export function subscribeMessages(listener: Listener): () => void {
  listeners.add(listener)
  listener()
  return () => listeners.delete(listener)
}

/** @deprecated use subscribeMessages */
export const subscribeChat = subscribeMessages

export function listThreads(): ChatThread[] {
  const { messages } = readState()
  const byPeer = new Map<string, { updatedAt: number; lastPreview: string; unread: number }>()
  for (const m of messages) {
    const prev = byPeer.get(m.peerId)
    const previewEligible = threadPreviewEligible(m)
    const unreadInc =
      previewEligible &&
      m.direction === 'in' &&
      !m.readAt &&
      m.kind !== 'system' &&
      m.kind !== 'whois'
        ? 1
        : 0
    if (!previewEligible) {
      if (!prev) {
        byPeer.set(m.peerId, {
          updatedAt: m.createdAt,
          lastPreview: '',
          unread: 0,
        })
      } else {
        byPeer.set(m.peerId, {
          updatedAt: Math.max(prev.updatedAt, m.createdAt),
          lastPreview: prev.lastPreview,
          unread: prev.unread,
        })
      }
      continue
    }
    const preview =
      m.kind === 'file' && m.meta?.attachment
        ? `${m.direction === 'out' ? 'You: ' : ''}File · ${m.meta.attachment.name}`
        : m.kind === 'tip'
          ? `${m.direction === 'out' ? 'You tipped' : 'Tip received'} · ${m.meta?.amountLabel ?? m.text}`
          : m.kind === 'system' || m.kind === 'whois'
        ? m.text.split('\n')[0]!.slice(0, 120)
        : m.direction === 'out'
          ? `You: ${m.text}`
          : m.text
    if (!prev) {
      byPeer.set(m.peerId, {
        updatedAt: m.createdAt,
        lastPreview: preview,
        unread: unreadInc,
      })
      continue
    }
    byPeer.set(m.peerId, {
      updatedAt: Math.max(prev.updatedAt, m.createdAt),
      lastPreview: m.createdAt >= prev.updatedAt ? preview : prev.lastPreview,
      unread: prev.unread + unreadInc,
    })
  }
  return [...byPeer.entries()]
    .map(([peerId, t]) => ({ peerId, ...t }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function listMessages(peerId: string): ChatMessage[] {
  return readState()
    .messages.filter((m) => m.peerId === peerId)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** One parse for background indexes that span every thread. */
export function listAllMessages(): readonly ChatMessage[] {
  return readState().messages
}

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

export function appendMessage(
  peerId: string,
  partial: Omit<ChatMessage, 'id' | 'peerId' | 'createdAt'> & { createdAt?: number },
): ChatMessage {
  const msg: ChatMessage = {
    id: uid(),
    peerId,
    createdAt: partial.createdAt ?? Date.now(),
    direction: partial.direction,
    kind: partial.kind,
    text: partial.text,
    meta: partial.meta,
    readAt:
      partial.readAt ??
      (partial.direction === 'out' || partial.direction === 'system' ? Date.now() : undefined),
  }
  const state = readState()
  state.messages.push(msg)
  writeState(state)
  return msg
}

export function updateMessage(
  id: string,
  patch: Partial<Pick<ChatMessage, 'text' | 'kind' | 'meta' | 'readAt'>>,
): ChatMessage | null {
  const state = readState()
  const idx = state.messages.findIndex((m) => m.id === id)
  if (idx < 0) return null
  const prev = state.messages[idx]!
  const next: ChatMessage = {
    ...prev,
    ...patch,
    meta: patch.meta !== undefined ? { ...prev.meta, ...patch.meta } : prev.meta,
  }
  state.messages[idx] = next
  writeState(state)
  return next
}

export function markThreadRead(peerId: string): void {
  const state = readState()
  let changed = false
  const now = Date.now()
  for (const m of state.messages) {
    if (m.peerId === peerId && m.direction === 'in' && !m.readAt) {
      m.readAt = now
      changed = true
    }
  }
  if (changed) writeState(state)
}

export function listMessagePeers(): Array<{
  peerId: string
  friend: Friend | null
  thread: ChatThread | null
}> {
  const friends = listFriends()
  const threads = listThreads()
  const byId = new Map(friends.map((f) => [f.id, f]))
  const seen = new Set<string>()
  const out: Array<{ peerId: string; friend: Friend | null; thread: ChatThread | null }> = []

  for (const t of threads) {
    seen.add(t.peerId)
    out.push({ peerId: t.peerId, friend: byId.get(t.peerId) ?? null, thread: t })
  }
  for (const f of friends) {
    if (seen.has(f.id)) continue
    out.push({ peerId: f.id, friend: f, thread: null })
  }
  return out
}

/** @deprecated */
export const listChatPeers = listMessagePeers

export function clearChatWithPeer(peerId: string): void {
  const state = readState()
  state.messages = state.messages.filter((m) => m.peerId !== peerId)
  writeState(state)
}

export function totalUnread(): number {
  return listThreads().reduce((n, t) => n + t.unread, 0)
}

/** Alias used by older pay-status naming */
export type ChatPayStatus = MessagePayStatus
export type ChatMessageKind = MessageKind
