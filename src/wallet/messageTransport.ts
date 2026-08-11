/**
 * Message transport — local-first with optional messagebox (BRC-33 semantics).
 *
 * Default host is BRC-CLOUD `/v1/messagebox` (HandCash convenience). That host is
 * not the protocol: BRC-169 resolve returns a `messagebox` URL; federation posts
 * to the recipient's box. See `docs/wallet-p2p-messagebox.md`.
 *
 * BRC-33 wire: send/list/ack shapes + `status: success`. Auth is interim
 * ECDSA identity headers (`messageboxAuth.ts`) until BRC-103/104 Authrite.
 * Bodies remain plaintext / `handcash-message:` app payloads (BRC-169 §7
 * encrypted envelopes deferred). `/files` is a HandCash extension.
 */
import {
  DEFAULT_BRC_CLOUD_BASE_URL,
  DEFAULT_METANET_HANDLES_BASE_URL,
} from './walletConfig'
import {
  messageboxAuthHeaders,
  signMessageboxAuth,
} from './messageboxAuth'
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
  /** Required to sign BRC-33-lite auth headers. */
  rootKeyHex: string
  senderHandle?: string
  body: string
  peerId: string
  /** Recipient's messagebox base; defaults to HandCash BRC-CLOUD. */
  messagebox?: string | null
}

export type ListedMessage = {
  messageId: string
  body: string
  /** BRC-33 field */
  sender?: string
  /** Legacy alias */
  senderIdentityKey?: string
  createdAt: number
}

function listedSender(m: ListedMessage): string {
  return String(m.sender || m.senderIdentityKey || '')
    .trim()
    .toLowerCase()
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
  rootKeyHex: string
  /** Recipient messagebox base; defaults to HandCash BRC-CLOUD. */
  messagebox?: string | null
}): Promise<ChatAttachment> {
  if (!(args.file.size > 0)) throw new Error('Choose a non-empty file')
  if (args.file.size > MAX_CHAT_FILE_BYTES) {
    throw new Error('Files are limited to 8 MB')
  }
  const box = normalizeMessageboxBase(args.messagebox)
  const auth = signMessageboxAuth({
    rootKeyHex: args.rootKeyHex,
    method: 'files',
    messageBox: 'inbox',
  })
  const res = await fetch(`${box}/files`, {
    method: 'POST',
    headers: {
      'Content-Type': args.file.type || 'application/octet-stream',
      'X-HandCash-Recipient': args.recipientIdentityKey,
      'X-HandCash-Filename': encodeURIComponent(args.file.name),
      ...messageboxAuthHeaders(auth),
    },
    body: args.file,
  })
  const data = (await res.json().catch(() => null)) as
    | { file?: ChatAttachment; error?: string; status?: string }
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
    const auth = signMessageboxAuth({
      rootKeyHex: env.rootKeyHex,
      method: 'sendMessage',
      messageBox: 'inbox',
    })
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...messageboxAuthHeaders(auth),
      },
      body: JSON.stringify({
        message: {
          recipient: env.recipientIdentityKey,
          messageBox: 'inbox',
          body: env.body,
          // Optional display claim only — server binds sender from auth.
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
  rootKeyHex: string
  peerIdForSender: (senderIdentityKey: string) => string | null
  /** Own messagebox base; defaults to HandCash BRC-CLOUD. */
  messagebox?: string | null
}): Promise<number> {
  const result = await pollInboundTipHints({
    rootKeyHex: args.rootKeyHex,
    peerIdForSender: args.peerIdForSender,
    messagebox: args.messagebox,
  })
  return result.messages
}

/**
 * List inbox; append chat for known friends; return how many tip hints carried a
 * txid so the wallet can force a chain ingest immediately.
 *
 * Tip hints are grade B (messagebox) — custody still comes from the address scan.
 * Unknown senders still accelerate ingest; chat rows require a friend mapping.
 */
export async function pollInboundTipHints(args: {
  rootKeyHex: string
  peerIdForSender?: (senderIdentityKey: string) => string | null
  messagebox?: string | null
}): Promise<{ messages: number; tipHints: number; paymentTxids: string[] }> {
  const box = normalizeMessageboxBase(args.messagebox)
  const url = `${box}/listMessages`
  try {
    const auth = signMessageboxAuth({
      rootKeyHex: args.rootKeyHex,
      method: 'listMessages',
      messageBox: 'inbox',
    })
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...messageboxAuthHeaders(auth),
      },
      body: JSON.stringify({ messageBox: 'inbox' }),
    })
    if (!res.ok) return { messages: 0, tipHints: 0, paymentTxids: [] }
    const data = (await res.json()) as { status?: string; messages?: ListedMessage[] }
    const list = Array.isArray(data.messages) ? data.messages : []
    const ackIds: string[] = []
    let messages = 0
    let tipHints = 0
    const paymentTxids: string[] = []
    for (const m of list) {
      const senderKey = listedSender(m)
      const peerId = args.peerIdForSender?.(senderKey) ?? null
      const decoded = decodeMessageBody(m.body)
      if (peerId) {
        appendMessage(peerId, {
          direction: 'in',
          kind: decoded.kind,
          text: decoded.text,
          createdAt: m.createdAt || Date.now(),
          meta: {
            ...decoded.meta,
            identityKey: senderKey,
            origin: 'messagebox',
            messagebox: box,
            status:
              decoded.kind === 'tip' || decoded.kind === 'pay-sent'
                ? 'Claimed · unverified'
                : decoded.meta?.status,
          },
        })
        messages += 1
      }
      if (
        (decoded.kind === 'tip' || decoded.kind === 'pay-sent') &&
        typeof decoded.meta?.txid === 'string' &&
        /^[0-9a-f]{64}$/i.test(decoded.meta.txid.trim())
      ) {
        tipHints += 1
        paymentTxids.push(decoded.meta.txid.trim().toLowerCase())
      }
      if (m.messageId) ackIds.push(String(m.messageId))
    }
    if (ackIds.length > 0) {
      void acknowledgeMessages(ackIds, args.rootKeyHex, box)
    }
    if (paymentTxids.length > 0 && typeof document !== 'undefined') {
      document.dispatchEvent(
        new CustomEvent('handcash:payment-hint', {
          detail: { txids: paymentTxids },
        }),
      )
    }
    return { messages, tipHints, paymentTxids }
  } catch {
    return { messages: 0, tipHints: 0, paymentTxids: [] }
  }
}

/**
 * Best-effort peer notify after a soft-latch item send — accelerates the
 * recipient's next ingest. Failures are ignored; chain custody still works.
 */
export async function notifyPeerItemIncoming(args: {
  recipientIdentityKey: string
  rootKeyHex: string
  senderIdentityKey: string
  senderHandle?: string | null
  messagebox?: string | null
  txid: string
  itemName: string
}): Promise<{ delivered: 'local' | 'cloud' }> {
  const txid = args.txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid)) return { delivered: 'local' }
  const name = args.itemName.trim() || 'item'
  const body = encodeMessageBody({
    kind: 'tip',
    text: `Sent you ${name}`,
    meta: { txid, sats: 1, status: 'Incoming', memo: name },
  })
  return deliverOutbound({
    recipientIdentityKey: args.recipientIdentityKey.trim().toLowerCase(),
    rootKeyHex: args.rootKeyHex,
    senderIdentityKey: args.senderIdentityKey,
    senderHandle: args.senderHandle ?? undefined,
    messagebox: args.messagebox,
    body,
    peerId: args.recipientIdentityKey.trim().toLowerCase(),
  })
}

async function acknowledgeMessages(
  messageIds: string[],
  rootKeyHex: string,
  messagebox?: string | null,
): Promise<void> {
  const box = normalizeMessageboxBase(messagebox)
  try {
    const auth = signMessageboxAuth({
      rootKeyHex,
      method: 'acknowledgeMessage',
      messageBox: 'inbox',
    })
    await fetch(`${box}/acknowledgeMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...messageboxAuthHeaders(auth),
      },
      body: JSON.stringify({ messageBox: 'inbox', messageIds }),
    })
  } catch {
    /* ignore */
  }
}
