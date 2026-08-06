/**
 * Message transport — local-first with optional BRC-CLOUD messagebox (BRC-33 / BRC-169 §7).
 */
import { DEFAULT_METANET_HANDLES_BASE_URL } from './walletConfig'
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

export type OutboundEnvelope = {
  recipientIdentityKey: string
  senderIdentityKey: string
  senderHandle?: string
  body: string
  peerId: string
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
    attachment?: ChatAttachment
  }
}

function messageboxUrl(baseUrl = DEFAULT_METANET_HANDLES_BASE_URL): string {
  return `${normalizeBase(baseUrl)}/v1/messagebox`
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
    file.url.startsWith(`${messageboxUrl()}/files/`)
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
        attachment: validAttachment(parsed.meta?.attachment)
          ? parsed.meta.attachment
          : undefined,
      },
    }
  } catch {
    return { kind: 'text', text: body }
  }
}

/** Upload an attachment to the messagebox's private, expiring R2 namespace. */
export async function uploadChatFile(args: {
  file: File
  recipientIdentityKey: string
  senderIdentityKey: string
}): Promise<ChatAttachment> {
  if (!(args.file.size > 0)) throw new Error('Choose a non-empty file')
  if (args.file.size > MAX_CHAT_FILE_BYTES) {
    throw new Error('Files are limited to 8 MB')
  }
  const res = await fetch(`${messageboxUrl()}/files`, {
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
  if (!res.ok || !data?.file) {
    throw new Error(data?.error || `File upload failed (${res.status})`)
  }
  return data.file
}

/** Deliver outbound text to cloud messagebox when available; always returns local-ok. */
export async function deliverOutbound(env: OutboundEnvelope): Promise<{ delivered: 'local' | 'cloud' }> {
  const url = `${messageboxUrl()}/sendMessage`
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
    if (res.ok) return { delivered: 'cloud' }
  } catch {
    /* local-only */
  }
  return { delivered: 'local' }
}

/** Poll messagebox for inbound; append as inbound text when peer mapped. */
export async function pollInbound(args: {
  identityKey: string
  peerIdForSender: (senderIdentityKey: string) => string | null
}): Promise<number> {
  const url = `${messageboxUrl()}/listMessages`
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
          payStatus:
            decoded.kind === 'tip' || decoded.kind === 'pay-sent' ? 'sent' : undefined,
        },
      })
      n += 1
      void acknowledgeMessage(m.messageId, args.identityKey)
    }
    return n
  } catch {
    return 0
  }
}

async function acknowledgeMessage(messageId: string, identityKey: string): Promise<void> {
  try {
    await fetch(`${messageboxUrl()}/acknowledgeMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ messageId, recipient: identityKey }),
    })
  } catch {
    /* ignore */
  }
}
