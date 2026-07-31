import { durableGetItem, durableSetItem } from './durableStorage'
import { listFriends, type Friend } from './friends'

const STORAGE_KEY = 'handcash.brc100.chat.v1'

export type ChatPayStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'cancelled'

export type ChatMessageKind = 'text' | 'system' | 'command' | 'pay-request' | 'pay-sent'

export type ChatMessage = {
  id: string
  /** Friend id of the peer thread */
  peerId: string
  /** Outbound from this wallet vs inbound (local/sim) */
  direction: 'out' | 'in' | 'system'
  kind: ChatMessageKind
  text: string
  createdAt: number
  /** Optional structured payload for cards */
  meta?: {
    amountLabel?: string
    sats?: number
    status?: string
    payStatus?: ChatPayStatus
    to?: string
    friendLabel?: string
    memo?: string
    txid?: string
    error?: string
  }
}

export type ChatThread = {
  peerId: string
  updatedAt: number
  lastPreview: string
}

type ChatState = {
  messages: ChatMessage[]
}

type Listener = () => void

const listeners = new Set<Listener>()

function notify() {
  for (const l of listeners) l()
}

function readState(): ChatState {
  try {
    const raw = durableGetItem(STORAGE_KEY)
    if (!raw) return { messages: [] }
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

export function subscribeChat(listener: Listener): () => void {
  listeners.add(listener)
  listener()
  return () => listeners.delete(listener)
}

export function listThreads(): ChatThread[] {
  const { messages } = readState()
  const byPeer = new Map<string, ChatThread>()
  for (const m of messages) {
    const prev = byPeer.get(m.peerId)
    if (!prev || m.createdAt >= prev.updatedAt) {
      byPeer.set(m.peerId, {
        peerId: m.peerId,
        updatedAt: m.createdAt,
        lastPreview:
          m.kind === 'system'
            ? m.text
            : m.direction === 'out'
              ? `You: ${m.text}`
              : m.text,
      })
    }
  }
  return [...byPeer.values()].sort((a, b) => b.updatedAt - a.updatedAt)
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
  }
  const state = readState()
  state.messages.push(msg)
  writeState(state)
  return msg
}

export function updateMessage(
  id: string,
  patch: Partial<Pick<ChatMessage, 'text' | 'kind' | 'meta'>>,
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

export function ensureThread(peerId: string): void {
  if (listMessages(peerId).length > 0) return
  // Touch with empty preview via a silent system note only when sending first msg
}

/** Friends that have chats, plus any orphan peer ids. */
export function listChatPeers(): Array<{ peerId: string; friend: Friend | null; thread: ChatThread | null }> {
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

export function clearChatWithPeer(peerId: string): void {
  const state = readState()
  state.messages = state.messages.filter((m) => m.peerId !== peerId)
  writeState(state)
}
