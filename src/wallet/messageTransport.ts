/**
 * Message transport — local-first with optional messagebox (BRC-33 semantics).
 *
 * Default host is BRC-CLOUD `/v1/messagebox` (HandCash convenience). That host is
 * not the protocol: BRC-169 resolve returns a `messagebox` URL; federation posts
 * to the recipient's box. See `docs/wallet-p2p-messagebox.md`.
 *
 * BRC-33 wire: send/list/ack shapes + `status: success`. Auth is interim
 * `X-BRC33-*` ECDSA (`messageboxAuth.ts`). Full Authrite / BRC-103 headers are
 * signed locally but not sent on fetch (Android CORS preflight).
 * Bodies remain plaintext / `handcash-message:` app payloads (BRC-169 §7
 * encrypted envelopes deferred). `/files` is a HandCash extension.
 */
import {
  DEFAULT_BRC_CLOUD_BASE_URL,
  DEFAULT_METANET_HANDLES_BASE_URL,
} from './walletConfig'
import {
  freshMessageboxAuthHeaders,
  type MessageboxMethod,
} from './messageboxAuth'
import {
  appendMessage,
  type ChatAttachment,
  type ChatMessage,
  type ItemTransferAsset,
  type MessageKind,
} from './messageStore'
import { rememberBeefBinary } from './beefCache'
import { noteInboundReceivePending } from './appActivity'
import { isGhostTxSuppressed } from './ghostTxSuppress'
import type {
  MarketPurchaseIntent,
  MarketSettlementReceipt,
} from './marketListing'

const WIRE_PREFIX = 'handcash-message:'
const MARKET_WIRE_PREFIX = 'handcash-market-v2:'
export const MAX_CHAT_FILE_BYTES = 8 * 1024 * 1024
/** BRC-CLOUD sendMessage cap is 16_384 — stay under it for remittance ± inline BEEF. */
export const MESSAGEBOX_BODY_MAX = 16_000

export type MarketSettlementWire =
  | {
      type: 'sign-request'
      saleId: string
      buyerIdentityKey: string
      intent: MarketPurchaseIntent
      buyerMessagebox?: string
      listing: unknown
      provenance: unknown
      signableBeefB64: string
      itemVin: number
      offerVin: number
      itemOutputIndex: number
      sellerOutputIndex: number
      feeOutputIndex: number
      expiresAt: number
    }
  | {
      type: 'sign-response'
      saleId: string
      accepted: boolean
      unlockingScript?: string
      offerUnlockingScript?: string
      reason?: string
    }
  | {
      type: 'receipt'
      saleId: string
      txid: string
      atomicBeefB64: string
      buyerMessagebox?: string
    }
  | {
      type: 'receipt-response'
      saleId: string
      txid: string
      broadcasted: boolean
      receipt: MarketSettlementReceipt
      reason?: string
    }

export function encodeMarketSettlementWire(wire: MarketSettlementWire): string {
  const body = `${MARKET_WIRE_PREFIX}${JSON.stringify(wire)}`
  if (body.length > MESSAGEBOX_BODY_MAX) {
    throw new Error('Market settlement message exceeds the BRC-33 body limit')
  }
  return body
}

export function decodeMarketSettlementWire(
  body: string,
): MarketSettlementWire | null {
  if (!body.startsWith(MARKET_WIRE_PREFIX)) return null
  try {
    const wire = JSON.parse(body.slice(MARKET_WIRE_PREFIX.length)) as
      | Partial<MarketSettlementWire>
      | null
    if (
      !wire ||
      typeof wire !== 'object' ||
      (wire.type !== 'sign-request' &&
        wire.type !== 'sign-response' &&
        wire.type !== 'receipt' &&
        wire.type !== 'receipt-response') ||
      typeof wire.saleId !== 'string' ||
      !wire.saleId
    ) {
      return null
    }
    return wire as MarketSettlementWire
  } catch {
    return null
  }
}

export async function deliverMarketSettlementWire(args: {
  wire: MarketSettlementWire
  recipientIdentityKey: string
  rootKeyHex: string
  senderIdentityKey: string
  messagebox?: string | null
}): Promise<boolean> {
  const sent = await deliverOutbound({
    recipientIdentityKey: args.recipientIdentityKey,
    rootKeyHex: args.rootKeyHex,
    senderIdentityKey: args.senderIdentityKey,
    messagebox: args.messagebox,
    body: encodeMarketSettlementWire(args.wire),
    peerId: args.recipientIdentityKey,
  })
  return sent.delivered === 'cloud'
}

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

type WireBrc29 = {
  derivationPrefix: string
  derivationSuffix: string
  outputIndex?: number
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
    /** BRC-29 remittance — peer tip/pay-sent only. */
    brc29?: WireBrc29
    /** Item/token settle (Atomic BEEF on attachment or beefB64). */
    item?: boolean
    /** Tagged asset grammar; absent means legacy collectable. */
    asset?: ItemTransferAsset
    /** Atomic BEEF as standard base64 when it fits in the 16KB sendMessage cap. */
    beefB64?: string
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function decodeBeefB64(raw?: string | null): number[] | undefined {
  if (!raw?.trim()) return undefined
  try {
    const bin = Uint8Array.from(atob(raw.trim()), (c) => c.charCodeAt(0))
    return bin.length > 0 ? Array.from(bin) : undefined
  } catch {
    return undefined
  }
}

/** Attach inline Atomic BEEF when the JSON body still fits the box cap. */
export function withOptionalBeefB64(
  body: string,
  atomicBeef?: number[],
): { body: string; beefInBox: boolean } {
  if (!atomicBeef?.length || !body.startsWith(WIRE_PREFIX)) {
    return { body, beefInBox: false }
  }
  try {
    const parsed = JSON.parse(body.slice(WIRE_PREFIX.length)) as WireMessage
    const next: WireMessage = {
      ...parsed,
      meta: {
        ...parsed.meta,
        beefB64: bytesToBase64(Uint8Array.from(atomicBeef)),
      },
    }
    const encoded = `${WIRE_PREFIX}${JSON.stringify(next)}`
    if (encoded.length > MESSAGEBOX_BODY_MAX) return { body, beefInBox: false }
    return { body: encoded, beefInBox: true }
  } catch {
    return { body, beefInBox: false }
  }
}

function validBrc29(value: unknown): value is WireBrc29 {
  if (!value || typeof value !== 'object') return false
  const r = value as Partial<WireBrc29>
  if (
    typeof r.derivationPrefix !== 'string' ||
    !r.derivationPrefix.trim() ||
    typeof r.derivationSuffix !== 'string' ||
    !r.derivationSuffix.trim()
  ) {
    return false
  }
  if (
    r.outputIndex != null &&
    (!Number.isInteger(r.outputIndex) || r.outputIndex < 0)
  ) {
    return false
  }
  return true
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
      brc29: validBrc29(message.meta?.brc29) ? message.meta.brc29 : undefined,
      item: message.meta?.item === true ? true : undefined,
      asset: validItemTransferAsset(message.meta?.asset)
        ? message.meta.asset
        : undefined,
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

function validItemTransferAsset(value: unknown): value is ItemTransferAsset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const asset = value as Partial<ItemTransferAsset>
  if (asset.kind === 'collectable') return true
  if (asset.kind === '1sat-ft') {
    return (
      typeof asset.origin === 'string' &&
      asset.origin.trim().length > 0 &&
      typeof asset.amount === 'string' &&
      /^\d+$/.test(asset.amount.trim()) &&
      typeof asset.sym === 'string'
    )
  }
  if (asset.kind !== 'fungible') return false
  return (
    typeof asset.tokenId === 'string' &&
    /^[0-9a-f]{64}[._]\d+$/i.test(asset.tokenId.trim()) &&
    typeof asset.amount === 'string' &&
    /^\d+$/.test(asset.amount.trim()) &&
    BigInt(asset.amount.trim()) > 0n &&
    typeof asset.sym === 'string' &&
    asset.sym.trim().length > 0 &&
    typeof asset.dec === 'number' &&
    Number.isInteger(asset.dec) &&
    asset.dec >= 0 &&
    asset.dec <= 18
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
        brc29: validBrc29(parsed.meta?.brc29)
          ? {
              derivationPrefix: parsed.meta.brc29.derivationPrefix.trim(),
              derivationSuffix: parsed.meta.brc29.derivationSuffix.trim(),
              outputIndex:
                typeof parsed.meta.brc29.outputIndex === 'number'
                  ? parsed.meta.brc29.outputIndex
                  : undefined,
            }
          : undefined,
        item: parsed.meta?.item === true ? true : undefined,
        asset: validItemTransferAsset(parsed.meta?.asset)
          ? parsed.meta.asset
          : undefined,
        beefB64:
          typeof parsed.meta?.beefB64 === 'string' && parsed.meta.beefB64.trim()
            ? parsed.meta.beefB64.trim()
            : undefined,
      },
    }
  } catch {
    return { kind: 'text', text: body }
  }
}

export type PeerBeefNotifyResult = {
  delivered: 'local' | 'cloud'
  /** True when Atomic BEEF rode along in sendMessage (payee can broadcast). */
  beefInBox: boolean
}

/** Sign-then-attach so retries cannot reuse a stale X-BRC33-Timestamp. */
function signedMessageboxHeaders(
  rootKeyHex: string,
  method: MessageboxMethod,
  extra?: Record<string, string>,
): Headers {
  const signed = freshMessageboxAuthHeaders({
    rootKeyHex,
    method,
    messageBox: 'inbox',
  })
  const headers = new Headers()
  if (extra) {
    for (const [key, value] of Object.entries(extra)) headers.set(key, value)
  }
  headers.set('X-BRC33-Identity', signed['X-BRC33-Identity'] ?? '')
  headers.set('X-BRC33-Timestamp', signed['X-BRC33-Timestamp'] ?? '')
  headers.set('X-BRC33-Signature', signed['X-BRC33-Signature'] ?? '')
  return headers
}

/**
 * Upload bytes to the recipient messagebox file store.
 *
 * Android WebView `fetch(new File(...))` throws `Failed to fetch`. Send a
 * `Blob` (not `File`) so Capacitor can POST the Atomic BEEF.
 */
export async function uploadMessageboxBytes(args: {
  bytes: Uint8Array
  filename: string
  contentType?: string
  recipientIdentityKey: string
  senderIdentityKey: string
  rootKeyHex: string
  messagebox?: string | null
}): Promise<ChatAttachment> {
  if (!(args.bytes.byteLength > 0)) throw new Error('Choose a non-empty file')
  if (args.bytes.byteLength > MAX_CHAT_FILE_BYTES) {
    throw new Error('Files are limited to 8 MB')
  }
  const box = normalizeMessageboxBase(args.messagebox)
  const filename = args.filename.trim() || 'attachment'
  const contentType = args.contentType || 'application/octet-stream'
  const payload = new Uint8Array(args.bytes.byteLength)
  payload.set(args.bytes)
  const res = await fetch(`${box}/files`, {
    method: 'POST',
    headers: signedMessageboxHeaders(args.rootKeyHex, 'files', {
      'Content-Type': contentType,
      'X-HandCash-Recipient': args.recipientIdentityKey,
      'X-HandCash-Filename': encodeURIComponent(filename),
    }),
    // Blob, not File — Android WebView rejects `File` as a fetch body.
    body: new Blob([payload.buffer], { type: contentType }),
  })
  const data = (await res.json().catch(() => null)) as
    | { file?: ChatAttachment; error?: string; status?: string }
    | null
  if (!res.ok || !data?.file || !validAttachment(data.file)) {
    throw new Error(data?.error || `File upload failed (${res.status})`)
  }
  return data.file
}

/** Upload an attachment to the (recipient) messagebox file store. */
export async function uploadChatFile(args: {
  file: Blob & { name?: string }
  recipientIdentityKey: string
  senderIdentityKey: string
  rootKeyHex: string
  /** Recipient messagebox base; defaults to HandCash BRC-CLOUD. */
  messagebox?: string | null
}): Promise<ChatAttachment> {
  const bytes = new Uint8Array(await args.file.arrayBuffer())
  return uploadMessageboxBytes({
    bytes,
    filename: args.file.name?.trim() || 'attachment',
    contentType: args.file.type || 'application/octet-stream',
    recipientIdentityKey: args.recipientIdentityKey,
    senderIdentityKey: args.senderIdentityKey,
    rootKeyHex: args.rootKeyHex,
    messagebox: args.messagebox,
  })
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
      headers: signedMessageboxHeaders(env.rootKeyHex, 'sendMessage', {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      }),
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
    const detail = await res.text().catch(() => '')
    console.warn(
      '[messagebox] sendMessage failed',
      res.status,
      box,
      detail.slice(0, 240),
    )
  } catch (err) {
    console.warn(
      '[messagebox] sendMessage error',
      box,
      err instanceof Error ? err.message : String(err),
    )
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
export type InboundPaymentHint = {
  txid: string
  messageId?: string
  senderIdentityKey: string
  satoshis?: number
  brc29?: WireBrc29
  beefUrl?: string
  /** Inline Atomic BEEF from sendMessage `beefB64`. */
  tx?: number[]
  item?: boolean
  itemName?: string
  asset?: ItemTransferAsset
}

export async function pollInboundTipHints(args: {
  rootKeyHex: string
  peerIdForSender?: (senderIdentityKey: string) => string | null
  messagebox?: string | null
}): Promise<{
  messages: number
  tipHints: number
  paymentTxids: string[]
  paymentHints: InboundPaymentHint[]
}> {
  const box = normalizeMessageboxBase(args.messagebox)
  const url = `${box}/listMessages`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: signedMessageboxHeaders(args.rootKeyHex, 'listMessages', {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      }),
      body: JSON.stringify({ messageBox: 'inbox' }),
    })
    if (!res.ok) {
      return { messages: 0, tipHints: 0, paymentTxids: [], paymentHints: [] }
    }
    const data = (await res.json()) as { status?: string; messages?: ListedMessage[] }
    const list = Array.isArray(data.messages) ? data.messages : []
    try {
      const { recoverPendingMarketPurchases } = await import('./marketSettlement')
      await recoverPendingMarketPurchases()
    } catch {
      /* recovery is best-effort beside inbox ingest */
    }
    const ackIds: string[] = []
    let messages = 0
    let tipHints = 0
    const paymentTxids: string[] = []
    const paymentHints: InboundPaymentHint[] = []
    for (const m of list) {
      const senderKey = listedSender(m)
      const marketWire = decodeMarketSettlementWire(m.body)
      if (marketWire) {
        try {
          const { handleInboundMarketSettlementWire } = await import(
            './marketSettlement'
          )
          const handled = await handleInboundMarketSettlementWire({
            wire: marketWire,
            senderIdentityKey: senderKey,
            messagebox: box,
          })
          if (handled && m.messageId) ackIds.push(String(m.messageId))
        } catch (err) {
          console.warn(
            '[market] inbound settlement message failed',
            err instanceof Error ? err.message : String(err),
          )
        }
        continue
      }
      const peerId = args.peerIdForSender?.(senderKey) ?? null
      const decoded = decodeMessageBody(m.body)
      const isPaymentHint =
        (decoded.kind === 'tip' || decoded.kind === 'pay-sent') &&
        typeof decoded.meta?.txid === 'string' &&
        /^[0-9a-f]{64}$/i.test(decoded.meta.txid.trim())
      const inlineBeef = decodeBeefB64(decoded.meta?.beefB64)
      if (inlineBeef && typeof decoded.meta?.txid === 'string') {
        rememberBeefBinary(decoded.meta.txid.trim().toLowerCase(), inlineBeef)
      }
      if (peerId) {
        const { beefB64: _omitBeef, ...chatMeta } = decoded.meta ?? {}
        appendMessage(peerId, {
          direction: 'in',
          kind: decoded.kind,
          text: decoded.text,
          createdAt: m.createdAt || Date.now(),
          meta: {
            ...chatMeta,
            identityKey: senderKey,
            origin: 'messagebox',
            messagebox: box,
            status:
              decoded.kind === 'tip' || decoded.kind === 'pay-sent'
                ? 'Receiving (SPV)'
                : decoded.meta?.status,
          },
        })
        messages += 1
      }
      if (isPaymentHint) {
        const txid = decoded.meta!.txid!.trim().toLowerCase()
        // Confirmed missing on-chain (no BEEF path left) — drop the inbox
        // message so tip polls stop re-pinning eternal Verifying…
        if (isGhostTxSuppressed(txid)) {
          if (m.messageId) ackIds.push(String(m.messageId))
          continue
        }
        tipHints += 1
        const item = decoded.meta?.item === true || undefined
        const itemName = decoded.meta?.memo?.trim() || undefined
        noteInboundReceivePending({
          txid,
          sats: decoded.meta?.sats,
          item,
          itemName,
          token:
            decoded.meta?.asset?.kind === 'fungible'
              ? decoded.meta.asset
              : undefined,
        })
        paymentTxids.push(txid)
        paymentHints.push({
          txid,
          messageId: m.messageId ? String(m.messageId) : undefined,
          senderIdentityKey: senderKey,
          satoshis: decoded.meta?.sats,
          brc29: decoded.meta?.brc29,
          beefUrl: decoded.meta?.attachment?.url,
          tx: decodeBeefB64(decoded.meta?.beefB64),
          item,
          itemName,
          asset: decoded.meta?.asset,
        })
        // Do not ACK until ingest succeeds — otherwise remittance is deleted
        // before Desktop can internalize.
      } else if (m.messageId) {
        ackIds.push(String(m.messageId))
      }
    }
    if (ackIds.length > 0) {
      void acknowledgeMessages(ackIds, args.rootKeyHex, box)
    }
    if (paymentHints.length > 0 && typeof document !== 'undefined') {
      document.dispatchEvent(
        new CustomEvent('handcash:payment-hint', {
          detail: { txids: paymentTxids, hints: paymentHints },
        }),
      )
    }
    return { messages, tipHints, paymentTxids, paymentHints }
  } catch {
    return { messages: 0, tipHints: 0, paymentTxids: [], paymentHints: [] }
  }
}

/**
 * Deliver a signed collectable or fungible tip to the peer (card ± Atomic BEEF).
 * `/files` is not used — Android WebView cannot POST binary reliably.
 * If BEEF does not fit in sendMessage, payee SPV-fetches after sender broadcast.
 */
export async function notifyPeerItemIncoming(args: {
  recipientIdentityKey: string
  rootKeyHex: string
  senderIdentityKey: string
  senderHandle?: string | null
  messagebox?: string | null
  txid: string
  itemName: string
  asset?: ItemTransferAsset
  atomicBeef?: number[]
}): Promise<PeerBeefNotifyResult> {
  const txid = args.txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid)) {
    return { delivered: 'local', beefInBox: false }
  }
  const name = args.itemName.trim() || 'item'
  const packed = withOptionalBeefB64(
    encodeMessageBody({
      kind: 'tip',
      text: `Sent you ${name}`,
      meta: {
        txid,
        sats: 1,
        status: 'Incoming',
        memo: name,
        item: true,
        asset: args.asset ?? { kind: 'collectable' },
      },
    }),
    args.atomicBeef,
  )

  const recipient = args.recipientIdentityKey.trim().toLowerCase()
  for (let attempt = 0; attempt < 5; attempt++) {
    const delivered = await deliverOutbound({
      recipientIdentityKey: recipient,
      rootKeyHex: args.rootKeyHex,
      senderIdentityKey: args.senderIdentityKey,
      senderHandle: args.senderHandle ?? undefined,
      messagebox: args.messagebox,
      body: packed.body,
      peerId: recipient,
    })
    if (delivered.delivered === 'cloud') {
      return { delivered: 'cloud', beefInBox: packed.beefInBox }
    }
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt))
  }
  return { delivered: 'local', beefInBox: false }
}

/**
 * Deliver a signed BRC-29 payment to the payee (remittance ± inline Atomic BEEF).
 * sendMessage is the delivery path — `/files` is not required.
 */
export async function notifyPeerBrc29Payment(args: {
  recipientIdentityKey: string
  rootKeyHex: string
  senderIdentityKey: string
  senderHandle?: string | null
  messagebox?: string | null
  txid: string
  satoshis: number
  remittance: {
    derivationPrefix: string
    derivationSuffix: string
    outputIndex?: number
  }
  amountLabel?: string
  atomicBeef?: number[]
}): Promise<PeerBeefNotifyResult> {
  const txid = args.txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid)) {
    return { delivered: 'local', beefInBox: false }
  }
  if (
    !args.remittance.derivationPrefix?.trim() ||
    !args.remittance.derivationSuffix?.trim()
  ) {
    return { delivered: 'local', beefInBox: false }
  }
  const sats =
    Number.isFinite(args.satoshis) && args.satoshis > 0
      ? Math.floor(args.satoshis)
      : 0
  const packed = withOptionalBeefB64(
    encodeMessageBody({
      kind: 'pay-sent',
      text: args.amountLabel || (sats > 0 ? `Pay ${sats} sats` : 'Payment'),
      meta: {
        txid,
        sats: sats > 0 ? sats : undefined,
        amountLabel: args.amountLabel,
        status: 'Incoming',
        brc29: {
          derivationPrefix: args.remittance.derivationPrefix,
          derivationSuffix: args.remittance.derivationSuffix,
          outputIndex: args.remittance.outputIndex ?? 0,
        },
      },
    }),
    args.atomicBeef,
  )

  const recipient = args.recipientIdentityKey.trim().toLowerCase()
  for (let attempt = 0; attempt < 5; attempt++) {
    const delivered = await deliverOutbound({
      recipientIdentityKey: recipient,
      rootKeyHex: args.rootKeyHex,
      senderIdentityKey: args.senderIdentityKey,
      senderHandle: args.senderHandle ?? undefined,
      messagebox: args.messagebox,
      body: packed.body,
      peerId: recipient,
    })
    if (delivered.delivered === 'cloud') {
      return { delivered: 'cloud', beefInBox: packed.beefInBox }
    }
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt))
  }
  return { delivered: 'local', beefInBox: false }
}

export async function acknowledgeMessageIds(
  messageIds: string[],
  rootKeyHex: string,
  messagebox?: string | null,
): Promise<void> {
  return acknowledgeMessages(messageIds, rootKeyHex, messagebox)
}

async function acknowledgeMessages(
  messageIds: string[],
  rootKeyHex: string,
  messagebox?: string | null,
): Promise<void> {
  const box = normalizeMessageboxBase(messagebox)
  try {
    await fetch(`${box}/acknowledgeMessage`, {
      method: 'POST',
      headers: signedMessageboxHeaders(rootKeyHex, 'acknowledgeMessage', {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      }),
      body: JSON.stringify({ messageBox: 'inbox', messageIds }),
    })
  } catch {
    /* ignore */
  }
}
