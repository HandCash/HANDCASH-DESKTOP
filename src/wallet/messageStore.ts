/**
 * Local-first Messages store (BRC-169 delivery + BRC-218 cards).
 * Persists across sessions; cloud sync is additive via messageTransport.
 */
import { durableGetItem, durableSetItem } from './durableStorage'
import { listFriends, type Friend } from './friends'

const STORAGE_KEY = 'handcash.messages.v1'
const LEGACY_KEY = 'handcash.brc100.chat.v1'

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
  | {
      kind: '1sat-ft'
      origin: string
      amount: string
      sym: string
      supply?: 'locked' | 'open'
      maxSupply?: number | null
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
    /** Item/token settle — Atomic BEEF rides inline; payee broadcasts. */
    item?: boolean
    /** Tagged asset grammar; absent on older collectable messages. */
    asset?: ItemTransferAsset
  }
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

type Listener = () => void

const listeners = new Set<Listener>()

function notify() {
  for (const l of listeners) l()
}

function migrateLegacy(): ChatState | null {
  try {
    const raw = durableGetItem(LEGACY_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ChatState
    if (!parsed || !Array.isArray(parsed.messages)) return null
    durableSetItem(STORAGE_KEY, JSON.stringify(parsed))
    return parsed
  } catch {
    return null
  }
}

function readState(): ChatState {
  try {
    const raw = durableGetItem(STORAGE_KEY)
    if (!raw) {
      const legacy = migrateLegacy()
      if (legacy) return legacy
      return { messages: [] }
    }
    const parsed = JSON.parse(raw) as ChatState
    if (!parsed || !Array.isArray(parsed.messages)) return { messages: [] }
    return { messages: parsed.messages }
  } catch {
    return { messages: [] }
  }
}

function writeState(state: ChatState) {
  durableSetItem(STORAGE_KEY, JSON.stringify(state))
  notify()
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
    const unreadInc =
      m.direction === 'in' && !m.readAt && m.kind !== 'system' && m.kind !== 'whois' ? 1 : 0
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
