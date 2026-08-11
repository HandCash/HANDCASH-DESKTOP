/**
 * Message transport — local-first with optional messagebox (BRC-33 semantics).
 *
 * Default host is BRC-CLOUD `/v1/messagebox` (HandCash convenience). That host is
 * not the protocol: BRC-169 resolve returns a `messagebox` URL; federation posts
 * to the recipient's box. See `docs/wallet-p2p-messagebox.md`.
 *
 * BRC-33 deltas still open (Phase 2): no BRC-31 auth; list/ack pass `recipient`
 * in the body; `/files` is a HandCash extension; bodies are mostly plaintext /
 * `handcash-message:` cards rather than encrypted envelopes.
 */
import {
  DEFAULT_BRC_CLOUD_BASE_URL,
  DEFAULT_METANET_HANDLES_BASE_URL,
} from './walletConfig'
import {
  appendMessage,
  type ChatAttachment,
  type ChatMessage,
  type MessageKind,
} from './messageStore'

const WIRE_PREFIX = 'handcash-message:'
export const MAX_CHAT_FILE_BYTES = 8 * 1024 * 1024

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/** HandCash convenience box — fallback when a peer has no resolved URL. */
export function defaultMessageboxBase(): string {
  return `${normalizeBase(DEFAULT_METANET_HANDLES_BASE_URL)}/v1/messagebox`
}

/**
 * Normalize a BRC-169 `messagebox` URL (or bare cloud origin) to the PeerServ
 * base used for sendMessage / listMessages / files.
 */
export function normalizeMessageboxBase(raw?: string | null): string {
  const fallback = defaultMessageboxBase()
  if (raw == null || !String(raw).trim()) return fallback
  let u = normalizeBase(String(raw))
  const cloud = normalizeBase(DEFAULT_BRC_CLOUD_BASE_URL)
  const handles = normalizeBase(DEFAULT_METANET_HANDLES_BASE_URL)
  if (u === cloud || u === handles) {
    return `${u}/v1/messagebox`
  }
  return u
}

/**
 * True when `url` is an https messagebox file pointer (any host).
 * Rejects non-https and non-messagebox paths (open-redirect / XSS vectors).
 */
export function isMessageboxFileUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    return /\/(?:v1\/)?messagebox\/files\//i.test(parsed.pathname)
  } catch {
    return false
  }
}

export type OutboundEnvelope = {
  recipientIdentityKey: string
  senderIdentityKey: string
  senderHandle?: string
  body: string
  peerId: string
  /** Recipient's messagebox base; defaults to HandCash BRC-CLOUD. */
  messagebox?: string | null
}

export type ListedMessage = {
  messageId: string
  body: string
  senderIdentityKey: string
  createdAt: number
}

type WireMessage = {
  version: 1
  kind: 'text' | 'pay-request' | 'pay-sent' | 'tip' | 'file'
  text: string
  meta?: {
    amountLabel?: string
    sats?: number
    status?: string
    memo?: string
    txid?: string
    boundMessageId?: string
    attachment?: ChatAttachment
  }
}

function wireKind(kind: MessageKind): WireMessage['kind'] {
  if (kind === 'pay-request' || kind === 'pay-sent' || kind === 'tip' || kind === 'file') {
    return kind
  }
  return 'text'
}

/** Preserve semantic chat cards across the string-only BRC-169 messagebox. */
export function encodeMessageBody(message: Pick<ChatMessage, 'kind' | 'text' | 'meta'>): string {
  if (message.kind === 'text') return message.text
  const wire: WireMessage = {
    version: 1,
    kind: wireKind(message.kind),
    text: message.text,
    meta: {
      amountLabel: message.meta?.amountLabel,
      sats: message.meta?.sats,
      status: message.meta?.status,
      memo: message.meta?.memo,
      txid: message.meta?.txid,
      boundMessageId: message.meta?.boundMessageId,
      attachment: message.meta?.attachment,
    },
  }
  return `${WIRE_PREFIX}${JSON.stringify(wire)}`
}

function validAttachment(value: unknown): value is ChatAttachment {
  if (!value || typeof value !== 'object') return false
  const file = value as Partial<ChatAttachment>
  return (
    typeof file.id === 'string' &&
    typeof file.name === 'string' &&
    typeof file.contentType === 'string' &&
    typeof file.size === 'number' &&
    file.size >= 0 &&
    file.size <= MAX_CHAT_FILE_BYTES &&
    typeof file.url === 'string' &&
    isMessageboxFileUrl(file.url)
  )
}

export function decodeMessageBody(body: string): {
  kind: WireMessage['kind']
  text: string
  meta?: WireMessage['meta']
} {
  if (!body.startsWith(WIRE_PREFIX)) return { kind: 'text', text: body }
  try {
    const parsed = JSON.parse(body.slice(WIRE_PREFIX.length)) as Partial<WireMessage>
    const kind = parsed.kind
    if (
      parsed.version !== 1 ||
      (kind !== 'text' &&
        kind !== 'pay-request' &&
        kind !== 'pay-sent' &&
        kind !== 'tip' &&
        kind !== 'file') ||
      typeof parsed.text !== 'string'
    ) {
      return { kind: 'text', text: body }
    }
    if (kind === 'file' && !validAttachment(parsed.meta?.attachment)) {
      return { kind: 'text', text: 'Unsupported file attachment' }
    }
    return {
      kind,
      text: parsed.text,
      meta: {
        amountLabel:
          typeof parsed.meta?.amountLabel === 'string' ? parsed.meta.amountLabel : undefined,
        sats:
          typeof parsed.meta?.sats === 'number' && parsed.meta.sats > 0
            ? Math.floor(parsed.meta.sats)
            : undefined,
        status: typeof parsed.meta?.status === 'string' ? parsed.meta.status : undefined,
        memo: typeof parsed.meta?.memo === 'string' ? parsed.meta.memo : undefined,
        txid: typeof parsed.meta?.txid === 'string' ? parsed.meta.txid : undefined,
        boundMessageId:
          typeof parsed.meta?.boundMessageId === 'string'
            ? parsed.meta.boundMessageId
            : undefined,
        attachment: validAttachment(parsed.meta?.attachment)
          ? parsed.meta.attachment
          : undefined,
      },
    }
  } catch {
    return { kind: 'text', text: body }
  }
}

/** Upload an attachment to the (recipient) messagebox file store. */
export async function uploadChatFile(args: {
  file: File
  recipientIdentityKey: string
  senderIdentityKey: string
  /** Recipient messagebox base; defaults to HandCash BRC-CLOUD. */
  messagebox?: string | null
}): Promise<ChatAttachment> {
  if (!(args.file.size > 0)) throw new Error('Choose a non-empty file')
  if (args.file.size > MAX_CHAT_FILE_BYTES) {
    throw new Error('Files are limited to 8 MB')
  }
  const box = normalizeMessageboxBase(args.messagebox)
  const res = await fetch(`${box}/files`, {
    method: 'POST',
    headers: {
      'Content-Type': args.file.type || 'application/octet-stream',
      'X-HandCash-Recipient': args.recipientIdentityKey,
      'X-HandCash-Sender': args.senderIdentityKey,
      'X-HandCash-Filename': encodeURIComponent(args.file.name),
    },
    body: args.file,
  })
  const data = (await res.json().catch(() => null)) as
    | { file?: ChatAttachment; error?: string }
    | null
  if (!res.ok || !data?.file || !validAttachment(data.file)) {
    throw new Error(data?.error || `File upload failed (${res.status})`)
  }
  return data.file
}

/** Deliver outbound text to the recipient's messagebox; always returns local-ok. */
export async function deliverOutbound(
  env: OutboundEnvelope,
): Promise<{ delivered: 'local' | 'cloud'; messagebox: string }> {
  const box = normalizeMessageboxBase(env.messagebox)
  const url = `${box}/sendMessage`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        message: {
          recipient: env.recipientIdentityKey,
          messageBox: 'inbox',
          body: env.body,
          sender: env.senderIdentityKey,
          senderHandle: env.senderHandle,
        },
      }),
    })
    if (res.ok) return { delivered: 'cloud', messagebox: box }
  } catch {
    /* local-only */
  }
  return { delivered: 'local', messagebox: box }
}

/** Poll own messagebox for inbound; append when the sender maps to a friend. */
export async function pollInbound(args: {
  identityKey: string
  peerIdForSender: (senderIdentityKey: string) => string | null
  /** Own messagebox base; defaults to HandCash BRC-CLOUD. */
  messagebox?: string | null
}): Promise<number> {
  const box = normalizeMessageboxBase(args.messagebox)
  const url = `${box}/listMessages`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        messageBox: 'inbox',
        recipient: args.identityKey,
      }),
    })
    if (!res.ok) return 0
    const data = (await res.json()) as { messages?: ListedMessage[] }
    const list = Array.isArray(data.messages) ? data.messages : []
    let n = 0
    for (const m of list) {
      const peerId = args.peerIdForSender(m.senderIdentityKey)
      if (!peerId) continue
      const decoded = decodeMessageBody(m.body)
      appendMessage(peerId, {
        direction: 'in',
        kind: decoded.kind,
        text: decoded.text,
        createdAt: m.createdAt || Date.now(),
        meta: {
          ...decoded.meta,
          identityKey: m.senderIdentityKey,
          origin: 'messagebox',
          messagebox: box,
          // Wire tip/pay cards are claims until chain verification exists.
          status:
            decoded.kind === 'tip' || decoded.kind === 'pay-sent'
              ? 'Claimed · unverified'
              : decoded.meta?.status,
        },
      })
      n += 1
      void acknowledgeMessage(m.messageId, args.identityKey, box)
    }
    return n
  } catch {
    return 0
  }
}

async function acknowledgeMessage(
  messageId: string,
  identityKey: string,
  messagebox?: string | null,
): Promise<void> {
  const box = normalizeMessageboxBase(messagebox)
  try {
    await fetch(`${box}/acknowledgeMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ messageId, recipient: identityKey }),
    })
  } catch {
    /* ignore */
  }
}
