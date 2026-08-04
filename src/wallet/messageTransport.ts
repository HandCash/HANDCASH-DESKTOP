/**
 * Message transport — local-first with optional BRC-CLOUD messagebox (BRC-33 / BRC-169 §7).
 */
import { DEFAULT_METANET_HANDLES_BASE_URL } from './walletConfig'
import { appendMessage } from './messageStore'

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

function messageboxUrl(baseUrl = DEFAULT_METANET_HANDLES_BASE_URL): string {
  return `${normalizeBase(baseUrl)}/v1/messagebox`
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
      appendMessage(peerId, {
        direction: 'in',
        kind: 'text',
        text: m.body,
        createdAt: m.createdAt || Date.now(),
        meta: { identityKey: m.senderIdentityKey, origin: 'messagebox' },
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
