/**
 * Message transport — local-first with optional messagebox (BRC-33 semantics).
 *
 * Default host is BRC-CLOUD `/v1/messagebox` (HandCash convenience). That host is
 * not the protocol: BRC-169 resolve returns a `messagebox` URL; federation posts
 * to the recipient's box. See `docs/wallet-p2p-messagebox.md`.
 *
 * BRC-33 wire: send/list/ack shapes + `status: success`. Auth is `X-BRC33-*`
 * plus `X-BRC103-*` on BRC-CLOUD (other boxes skip extra headers to avoid
 * Android CORS misses). Bodies are BRC-169 §7 envelopes (BRC-78 content).
 * Legacy plaintext inbound still decodes. `/files` is a HandCash extension.
 *
 * A live draft-BRC-246 IPv6 session carries the same sealed body and skips the
 * box for that message. The box stays the rendezvous and the offline inbox.
 */
import { Hash, PrivateKey, Utils } from '@bsv/sdk'
import {
  DEFAULT_BRC_CLOUD_BASE_URL,
  DEFAULT_METANET_HANDLES_BASE_URL,
  PUBLIC_BRC_CLOUD_ORIGIN,
} from './walletConfig'
import {
  freshMessageboxAuthHeaders,
  type MessageboxMethod,
} from './messageboxAuth'
import { getFriendByIdentityKey } from './friends'
import { openPeerMessage, sealPeerMessage } from './messageEnvelope'
import {
  appendMessage,
  type ChatAttachment,
  type ChatMessage,
  type ItemTransferAsset,
  type ItemTransferMember,
  type MessageKind,
} from './messageStore'
import { rememberBeefBinary } from './beefCache'
import { noteInboundReceivePending } from './appActivity'
import { isGhostTxSuppressed } from './ghostTxSuppress'
import type {
  MarketPurchaseIntent,
  MarketSettlementReceipt,
} from './marketListing'
import { bytesToBase64 } from './base64Binary'
import { installElectronDirectSession } from './directSession/bridge'
import {
  encodeRemittanceForPeerBox,
  parseProvenanceV2,
  type ProvenanceV2,
} from './oneSatProvenance'
import {
  ensureDirectListener,
  ingestSessionOfferBody,
  sessionOfferMessage,
  setDirectInboundHandler,
  setDirectSessionIdentity,
  tryDirectDeliver,
  warmDirectSession,
} from './directSession/session'

export { bytesToBase64 }

const WIRE_PREFIX = 'handcash-message:'
const MARKET_WIRE_PREFIX = 'handcash-market-v2:'
export const MAX_CHAT_FILE_BYTES = 8 * 1024 * 1024
/** BRC-CLOUD sendMessage cap is 16_384 — stay under it for remittance ± inline BEEF. */
export const MESSAGEBOX_BODY_MAX = 16_000
/** Inner plaintext budget so a BRC-169 envelope still fits `MESSAGEBOX_BODY_MAX`. */
export const MESSAGEBOX_INNER_MAX = 11_000

export type MarketSettlementWire =
  | {
      type: 'sign-request'
      saleId: string
      buyerIdentityKey: string
      buyerAddress?: string
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
      /** Omitted when AtomicBEEF exceeds the BRC-33 body cap; seller SPV-fetches by txid. */
      atomicBeefB64?: string
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

type MarketSettlementEnvelope =
  | MarketSettlementWire
  | {
      type: 'file'
      saleId: string
      url: string
      size: number
      sha256: string
    }

export function encodeMarketSettlementWire(
  wire: MarketSettlementEnvelope
): string {
  const body = `${MARKET_WIRE_PREFIX}${JSON.stringify(wire)}`
  if (body.length > MESSAGEBOX_INNER_MAX) {
    throw new Error('Market settlement message exceeds the BRC-33 body limit')
  }
  return body
}

export function decodeMarketSettlementWire(
  body: string,
): MarketSettlementEnvelope | null {
  if (!body.startsWith(MARKET_WIRE_PREFIX)) return null
  try {
    const wire = JSON.parse(body.slice(MARKET_WIRE_PREFIX.length)) as
      | Partial<MarketSettlementEnvelope>
      | null
    if (
      !wire ||
      typeof wire !== 'object' ||
      (wire.type !== 'file' &&
        wire.type !== 'sign-request' &&
        wire.type !== 'sign-response' &&
        wire.type !== 'receipt' &&
        wire.type !== 'receipt-response') ||
      typeof wire.saleId !== 'string' ||
      !wire.saleId
    ) {
      return null
    }
    return wire as MarketSettlementEnvelope
  } catch {
    return null
  }
}

async function resolveMarketSettlementWire(
  wire: MarketSettlementEnvelope
): Promise<MarketSettlementWire> {
  if (wire.type !== 'file') return wire
  if (
    !isMessageboxFileUrl(wire.url) ||
    !Number.isSafeInteger(wire.size) ||
    wire.size <= 0 ||
    wire.size > MAX_CHAT_FILE_BYTES ||
    !/^[0-9a-f]{64}$/i.test(wire.sha256)
  ) {
    throw new Error('Invalid market settlement file reference')
  }
  const response = await fetch(wire.url)
  if (!response.ok) {
    throw new Error(`Market settlement file download failed (${response.status})`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength !== wire.size || bytes.byteLength > MAX_CHAT_FILE_BYTES) {
    throw new Error('Market settlement file size mismatch')
  }
  if (Utils.toHex(Hash.sha256([...bytes])) !== wire.sha256.toLowerCase()) {
    throw new Error('Market settlement file hash mismatch')
  }
  const resolved = decodeMarketSettlementWire(new TextDecoder().decode(bytes))
  if (!resolved || resolved.type === 'file' || resolved.saleId !== wire.saleId) {
    throw new Error('Invalid market settlement file')
  }
  return resolved
}

export async function deliverMarketSettlementWire(args: {
  wire: MarketSettlementWire
  recipientIdentityKey: string
  rootKeyHex: string
  senderIdentityKey: string
  messagebox?: string | null
}): Promise<boolean> {
  let wire = args.wire
  if (wire.type === 'receipt' && wire.atomicBeefB64) {
    try {
      const active = (await import('./session')).getActiveWallet()
      if (active) {
        const { mergeLocalUnconfirmedAncestry, rememberBeefTree } = await import(
          './beefCache'
        )
        const decoded = decodeBeefB64(wire.atomicBeefB64)
        if (!decoded?.length) throw new Error('Invalid settlement Atomic BEEF')
        const completed = await mergeLocalUnconfirmedAncestry(
          active,
          decoded,
        )
        rememberBeefTree(completed, wire.txid)
        wire = {
          ...wire,
          atomicBeefB64: bytesToBase64(Uint8Array.from(completed)),
        }
      }
    } catch (error) {
      console.warn('[market-wire] ancestry completion skipped', error)
    }
  }
  let body: string
  try {
    body = encodeMarketSettlementWire(wire)
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !/BRC-33 body limit/i.test(error.message)
    ) {
      throw error
    }
    if (wire.type !== 'receipt' || !wire.atomicBeefB64) throw error
    // Market custody must never depend on messagebox `/files` (Android cannot
    // reliably fetch those pointers). Keep the receipt inline and let the
    // seller resolve the already-broadcast transaction by txid.
    body = encodeMarketSettlementWire({
      ...wire,
      atomicBeefB64: undefined,
    })
  }
  const sent = await deliverOutbound({
    recipientIdentityKey: args.recipientIdentityKey,
    rootKeyHex: args.rootKeyHex,
    senderIdentityKey: args.senderIdentityKey,
    messagebox: args.messagebox,
    body,
    peerId: args.recipientIdentityKey,
  })
  return deliveryReachedPeer(sent.delivered)
}

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/** HandCash convenience box — fallback when a peer has no resolved URL. */
export function defaultMessageboxBase(): string {
  return `${normalizeBase(DEFAULT_METANET_HANDLES_BASE_URL)}/v1/messagebox`
}

/**
 * Externally reachable messagebox URL for durable protocol records.
 * Development fetches use a same-origin `/v1/messagebox` proxy, but embedding
 * that relative route in a signed market offer makes `new URL()` fail.
 */
export function publicMessageboxBase(raw?: string | null): string {
  const normalized = normalizeMessageboxBase(raw)
  if (!normalized.startsWith('/')) return normalized
  return new URL(normalized, `${PUBLIC_BRC_CLOUD_ORIGIN}/`).href.replace(
    /\/+$/,
    '',
  )
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

export function deliveryReachedPeer(delivered: 'local' | 'cloud' | 'direct'): boolean {
  return delivered === 'cloud' || delivered === 'direct'
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
    /** Genesis origin for collectable settle — helps payee paint art while verifying. */
    itemOrigin?: string
    itemCollectionId?: string
    itemOutputIndex?: number
    /** Tagged asset grammar; absent means legacy collectable. */
    asset?: ItemTransferAsset
    /** Per-output identity for a multi-item transaction. */
    items?: ItemTransferMember[]
    /** Atomic BEEF as standard base64 when it fits in the 16KB sendMessage cap. */
    beefB64?: string
    /** BRC-150 remittance for this hop — peer verifies identity from the package. */
    provenance?: ProvenanceV2
    /** Intentional in-thread pay/tip card — not a silent Send-panel notify. */
    chatRef?: boolean
  }
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

/** Attach inline BRC-150 remittance when the JSON body still fits the box cap. */
export function withOptionalProvenance(
  body: string,
  provenance?: unknown,
): { body: string; provenanceInBox: boolean } {
  const parsedProof = parseProvenanceV2(provenance)
  if (!parsedProof || !body.startsWith(WIRE_PREFIX)) {
    return { body, provenanceInBox: false }
  }
  try {
    const parsed = JSON.parse(body.slice(WIRE_PREFIX.length)) as WireMessage
    const budgets = [
      parsedProof.beefB64.length,
      8_000,
      4_000,
      2_000,
      800,
    ]
    for (const maxB64 of budgets) {
      const fitted = encodeRemittanceForPeerBox(parsedProof, maxB64)
      if (!fitted) continue
      const encoded = `${WIRE_PREFIX}${JSON.stringify({
        ...parsed,
        meta: { ...parsed.meta, provenance: fitted },
      } satisfies WireMessage)}`
      if (encoded.length <= MESSAGEBOX_INNER_MAX) {
        return { body: encoded, provenanceInBox: true }
      }
    }
    return { body, provenanceInBox: false }
  } catch {
    return { body, provenanceInBox: false }
  }
}
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
    if (encoded.length > MESSAGEBOX_INNER_MAX) {
      return { body, beefInBox: false }
    }
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
      itemOrigin:
        typeof message.meta?.itemOrigin === 'string'
          ? message.meta.itemOrigin
          : undefined,
      itemCollectionId:
        typeof message.meta?.itemCollectionId === 'string'
          ? message.meta.itemCollectionId
          : undefined,
      itemOutputIndex:
        Number.isInteger(message.meta?.itemOutputIndex) &&
        Number(message.meta?.itemOutputIndex) >= 0
          ? Number(message.meta?.itemOutputIndex)
          : undefined,
      asset: validItemTransferAsset(message.meta?.asset)
        ? message.meta.asset
        : undefined,
      items: validItemTransferMembers(message.meta?.items),
      provenance: parseProvenanceV2(message.meta?.provenance) ?? undefined,
      chatRef: message.meta?.chatRef === true ? true : undefined,
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

function validItemTransferMembers(value: unknown): ItemTransferMember[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 25) {
    return undefined
  }
  const members: ItemTransferMember[] = []
  const seen = new Set<number>()
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const row = raw as Partial<ItemTransferMember>
    if (
      !Number.isInteger(row.outputIndex) ||
      row.outputIndex! < 0 ||
      seen.has(row.outputIndex!) ||
      typeof row.name !== 'string' ||
      !row.name.trim() ||
      typeof row.origin !== 'string' ||
      !/^[0-9a-f]{64}[._]\d+$/i.test(row.origin.trim())
    ) {
      return undefined
    }
    seen.add(row.outputIndex!)
    members.push({
      outputIndex: row.outputIndex!,
      name: row.name.trim().slice(0, 80),
      origin: row.origin.trim().replace(/\.(\d+)$/, '_$1').toLowerCase(),
      ...(typeof row.collectionId === 'string' && row.collectionId.trim()
        ? { collectionId: row.collectionId.trim().slice(0, 80) }
        : {}),
      ...(parseProvenanceV2(row.provenance)
        ? { provenance: parseProvenanceV2(row.provenance)! }
        : {}),
    })
  }
  return members
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
        itemOrigin:
          typeof parsed.meta?.itemOrigin === 'string'
            ? parsed.meta.itemOrigin.trim() || undefined
            : undefined,
        itemCollectionId:
          typeof parsed.meta?.itemCollectionId === 'string'
            ? parsed.meta.itemCollectionId.trim() || undefined
            : undefined,
        itemOutputIndex:
          Number.isInteger(parsed.meta?.itemOutputIndex) &&
          Number(parsed.meta?.itemOutputIndex) >= 0
            ? Number(parsed.meta?.itemOutputIndex)
            : undefined,
        asset: validItemTransferAsset(parsed.meta?.asset)
          ? parsed.meta.asset
          : undefined,
        items: validItemTransferMembers(parsed.meta?.items),
        beefB64:
          typeof parsed.meta?.beefB64 === 'string' && parsed.meta.beefB64.trim()
            ? parsed.meta.beefB64.trim()
            : undefined,
        provenance: parseProvenanceV2(parsed.meta?.provenance) ?? undefined,
        chatRef: parsed.meta?.chatRef === true ? true : undefined,
      },
    }
  } catch {
    return { kind: 'text', text: body }
  }
}

export type PeerBeefNotifyResult = {
  delivered: 'local' | 'cloud' | 'direct'
  /** True when Atomic BEEF rode along in sendMessage (payee can broadcast). */
  beefInBox: boolean
  /** True when BRC-150 remittance rode along (payee can verify identity). */
  provenanceInBox: boolean
}

function messageboxHostAllowsAuthrite(box: string): boolean {
  const n = normalizeBase(box)
  if (n.startsWith('/')) return true
  try {
    return new URL(n).host.toLowerCase() === 'brc-cloud.bcryderman.workers.dev'
  } catch {
    return false
  }
}

/** Sign-then-attach so retries cannot reuse a stale X-BRC33-Timestamp. */
function signedMessageboxHeaders(
  rootKeyHex: string,
  method: MessageboxMethod,
  extra: Record<string, string> | undefined,
  box: string,
): Headers {
  const signed = freshMessageboxAuthHeaders({
    rootKeyHex,
    method,
    messageBox: 'inbox',
    includeAuthrite: messageboxHostAllowsAuthrite(box),
  })
  const headers = new Headers()
  if (extra) {
    for (const [key, value] of Object.entries(extra)) headers.set(key, value)
  }
  for (const [key, value] of Object.entries(signed)) headers.set(key, value)
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
    }, box),
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

function dropInnerBeef(body: string): string {
  if (!body.startsWith(WIRE_PREFIX)) return body
  try {
    const parsed = JSON.parse(body.slice(WIRE_PREFIX.length)) as WireMessage
    if (!parsed.meta?.beefB64) return body
    const { beefB64: _omit, ...meta } = parsed.meta
    return `${WIRE_PREFIX}${JSON.stringify({ ...parsed, meta })}`
  } catch {
    return body
  }
}

function sealForPeer(args: {
  plaintext: string
  rootKeyHex: string
  recipientIdentityKey: string
}): string {
  let sealed = sealPeerMessage(args)
  if (sealed.length <= MESSAGEBOX_BODY_MAX) return sealed
  const stripped = dropInnerBeef(args.plaintext)
  if (stripped !== args.plaintext) {
    sealed = sealPeerMessage({ ...args, plaintext: stripped })
    if (sealed.length <= MESSAGEBOX_BODY_MAX) return sealed
  }
  throw new Error('Message exceeds the BRC-33 body limit')
}

function plaintextFromPeer(
  body: string,
  rootKeyHex: string,
  expectedSenderIdentityKey?: string,
): string | null {
  const opened = openPeerMessage({
    body,
    rootKeyHex,
    expectedSenderIdentityKey,
  })
  if ('refuse' in opened) return null
  return opened.plaintext
}

function threadIdForSender(identityKey: string): string | null {
  return getFriendByIdentityKey(identityKey)?.id ?? null
}

function armDirectSession(env: { rootKeyHex: string; senderIdentityKey: string }): void {
  installElectronDirectSession()
  setDirectSessionIdentity({
    rootKeyHex: env.rootKeyHex,
    identityKey: env.senderIdentityKey,
  })
  setDirectInboundHandler((sender, body) => {
    acceptDirectBody(sender, body, env.rootKeyHex)
  })
}

/**
 * Bind the IPv6 listener and put a short-lived offer in the friend's box so a
 * live pair can move chat onto the socket before the next typed line.
 */
export async function preparePeerDirectPath(args: {
  rootKeyHex: string
  senderIdentityKey: string
  recipientIdentityKey: string
  messagebox?: string | null
}): Promise<void> {
  armDirectSession(args)
  const box = normalizeMessageboxBase(args.messagebox)
  await postSessionOffer(
    {
      recipientIdentityKey: args.recipientIdentityKey,
      senderIdentityKey: args.senderIdentityKey,
      rootKeyHex: args.rootKeyHex,
      body: '',
      peerId: threadIdForSender(args.recipientIdentityKey) ?? args.recipientIdentityKey,
      messagebox: box,
    },
    box,
  )
  warmDirectSession(args.recipientIdentityKey)
}

/** Deliver outbound text. A live IPv6 session skips the box; otherwise the box is the path. */
export async function deliverOutbound(
  env: OutboundEnvelope,
): Promise<{ delivered: 'local' | 'cloud' | 'direct'; messagebox: string }> {
  const box = normalizeMessageboxBase(env.messagebox)
  armDirectSession(env)
  let wireBody = env.body
  if (env.body) {
    try {
      wireBody = sealForPeer({
        plaintext: env.body,
        rootKeyHex: env.rootKeyHex,
        recipientIdentityKey: env.recipientIdentityKey,
      })
    } catch (err) {
      console.warn(
        '[messagebox] seal failed',
        err instanceof Error ? err.message : String(err),
      )
      return { delivered: 'local', messagebox: box }
    }
  }
  if (wireBody) {
    const direct = await tryDirectDeliver({
      recipientIdentityKey: env.recipientIdentityKey,
      body: wireBody,
    })
    if (direct === 'direct') return { delivered: 'direct', messagebox: box }
  }
  const url = `${box}/sendMessage`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: signedMessageboxHeaders(env.rootKeyHex, 'sendMessage', {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      }, box),
      body: JSON.stringify({
        message: {
          recipient: env.recipientIdentityKey,
          messageBox: 'inbox',
          body: wireBody,
          // Optional display claim only — server binds sender from auth.
          senderHandle: env.senderHandle,
        },
      }),
    })
    if (res.ok) {
      void postSessionOffer(env, box)
      return { delivered: 'cloud', messagebox: box }
    }
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

async function postSessionOffer(env: OutboundEnvelope, box: string): Promise<void> {
  await ensureDirectListener()
  const offer = sessionOfferMessage(env.recipientIdentityKey)
  if (!offer) return
  let body = offer
  try {
    body = sealForPeer({
      plaintext: offer,
      rootKeyHex: env.rootKeyHex,
      recipientIdentityKey: env.recipientIdentityKey,
    })
  } catch {
    return
  }
  try {
    await fetch(`${box}/sendMessage`, {
      method: 'POST',
      headers: signedMessageboxHeaders(env.rootKeyHex, 'sendMessage', {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      }, box),
      body: JSON.stringify({
        message: {
          recipient: env.recipientIdentityKey,
          messageBox: 'inbox',
          body,
        },
      }),
    })
  } catch {
    /* the payload already landed; the offer can ride the next box send */
  }
}

function acceptDirectBody(sender: string, body: string, rootKeyHex: string): void {
  const inner = plaintextFromPeer(body, rootKeyHex, sender)
  if (inner == null) return
  if (ingestSessionOfferBody(inner)) {
    warmDirectSession(sender)
    return
  }
  const decoded = decodeMessageBody(inner)
  const senderKey = sender.trim().toLowerCase()
  const peerId = threadIdForSender(senderKey)
  const inlineBeef = decodeBeefB64(decoded.meta?.beefB64)
  if (inlineBeef && typeof decoded.meta?.txid === 'string') {
    rememberBeefBinary(decoded.meta.txid.trim().toLowerCase(), inlineBeef)
  }
  if (peerId) {
    appendMessage(peerId, {
      direction: 'in',
      kind: decoded.kind,
      text: decoded.text,
      createdAt: Date.now(),
      meta: {
        ...(decoded.meta ?? {}),
        identityKey: senderKey,
        origin: 'direct',
      },
    })
  }
  const txid = decoded.meta?.txid?.trim().toLowerCase()
  if (
    txid &&
    /^[0-9a-f]{64}$/.test(txid) &&
    (decoded.kind === 'tip' || decoded.kind === 'pay-sent') &&
    !isGhostTxSuppressed(txid)
  ) {
    noteInboundReceivePending({
      txid,
      sats: decoded.meta?.sats,
      item: decoded.meta?.item === true || undefined,
      itemName: decoded.meta?.memo?.trim() || undefined,
      token: decoded.meta?.asset?.kind === 'fungible' ? decoded.meta.asset : undefined,
    })
    if (typeof document !== 'undefined') {
      document.dispatchEvent(
        new CustomEvent('handcash:payment-hint', {
          detail: {
            txids: [txid],
            hints: [
              {
                txid,
                senderIdentityKey: senderKey,
                satoshis: decoded.meta?.sats,
                brc29: decoded.meta?.brc29,
                beefUrl: decoded.meta?.attachment?.url,
                tx: decodeBeefB64(decoded.meta?.beefB64),
                item: decoded.meta?.item === true || undefined,
                itemName: decoded.meta?.memo?.trim() || undefined,
                itemOrigin: decoded.meta?.itemOrigin,
                itemCollectionId: decoded.meta?.itemCollectionId,
                itemOutputIndex: decoded.meta?.itemOutputIndex,
                asset: decoded.meta?.asset,
                items: decoded.meta?.items,
                provenance: decoded.meta?.provenance,
              },
            ],
          },
        }),
      )
    }
  }
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
  itemOrigin?: string
  itemCollectionId?: string
  itemOutputIndex?: number
  asset?: ItemTransferAsset
  items?: ItemTransferMember[]
  provenance?: ProvenanceV2
}

const MARKET_RECOVERY_POLL_MS = 60_000
let marketRecoveryStartedAt = 0
let marketRecoveryInFlight: Promise<void> | null = null

/**
 * Market recovery is maintenance, not part of the five-second inbox heartbeat.
 * Keep it off the critical path and coalesce callers so a slow BEEF recovery
 * cannot delay chat/payment delivery or overlap itself.
 */
function scheduleMarketRecovery(): void {
  if (marketRecoveryInFlight) return
  const now = Date.now()
  if (now - marketRecoveryStartedAt < MARKET_RECOVERY_POLL_MS) return
  marketRecoveryStartedAt = now
  marketRecoveryInFlight = import('./marketSettlement')
    .then(({ recoverPendingMarketPurchases }) => recoverPendingMarketPurchases())
    .catch(() => {
      /* recovery remains best-effort */
    })
    .finally(() => {
      marketRecoveryInFlight = null
    })
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
      }, box),
      body: JSON.stringify({ messageBox: 'inbox' }),
    })
    if (!res.ok) {
      return { messages: 0, tipHints: 0, paymentTxids: [], paymentHints: [] }
    }
    const data = (await res.json()) as { status?: string; messages?: ListedMessage[] }
    const list = Array.isArray(data.messages) ? data.messages : []
    scheduleMarketRecovery()
    const ackIds: string[] = []
    let messages = 0
    let tipHints = 0
    const paymentTxids: string[] = []
    const paymentHints: InboundPaymentHint[] = []
    try {
      armDirectSession({
        rootKeyHex: args.rootKeyHex,
        senderIdentityKey: PrivateKey.fromHex(args.rootKeyHex.trim())
          .toPublicKey()
          .toString(),
      })
    } catch {
      /* locked or unreadable key — inbox parse still runs */
    }
    void ensureDirectListener()
    for (const m of list) {
      const senderKey = listedSender(m)
      const inner = plaintextFromPeer(m.body, args.rootKeyHex, senderKey)
      if (inner == null) continue
      if (ingestSessionOfferBody(inner)) {
        warmDirectSession(senderKey)
        if (m.messageId) ackIds.push(String(m.messageId))
        continue
      }
      const encodedMarketWire = decodeMarketSettlementWire(inner)
      if (encodedMarketWire) {
        try {
          const marketWire = await resolveMarketSettlementWire(encodedMarketWire)
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
      const peerId = args.peerIdForSender?.(senderKey) ?? threadIdForSender(senderKey)
      const decoded = decodeMessageBody(inner)
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
          itemOrigin: decoded.meta?.itemOrigin,
          itemCollectionId: decoded.meta?.itemCollectionId,
          itemOutputIndex: decoded.meta?.itemOutputIndex,
          asset: decoded.meta?.asset,
          items: decoded.meta?.items,
          provenance: decoded.meta?.provenance,
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
 * Deliver a signed collectable or fungible tip with its Atomic BEEF.
 * Small proofs ride inline; larger proofs use the messagebox file store as a
 * Blob and the inbox card carries the authenticated URL. Never silently drop a
 * supplied proof and force the receiver back onto indexer discovery.
 */
export async function notifyPeerItemIncoming(args: {
  recipientIdentityKey: string
  rootKeyHex: string
  senderIdentityKey: string
  senderHandle?: string | null
  messagebox?: string | null
  txid: string
  itemName: string
  itemOrigin?: string
  itemCollectionId?: string
  itemOutputIndex?: number
  asset?: ItemTransferAsset
  atomicBeef?: number[]
  provenance?: unknown
}): Promise<PeerBeefNotifyResult> {
  const none: PeerBeefNotifyResult = {
    delivered: 'local',
    beefInBox: false,
    provenanceInBox: false,
  }
  const txid = args.txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid)) {
    return none
  }
  let atomicBeef = args.atomicBeef
  if (atomicBeef?.length) {
    try {
      const active = (await import('./session')).getActiveWallet()
      if (active) {
        const { mergeLocalUnconfirmedAncestry, rememberBeefTree } = await import(
          './beefCache'
        )
        atomicBeef = await mergeLocalUnconfirmedAncestry(active, atomicBeef)
        rememberBeefTree(atomicBeef, txid)
      }
    } catch (error) {
      console.warn('[messagebox] item ancestry completion skipped', error)
    }
  }
  const name = args.itemName.trim() || 'item'
  const itemOrigin = args.itemOrigin?.trim() || undefined
  const itemCollectionId = args.itemCollectionId?.trim() || undefined
  const itemMessage = () =>
    encodeMessageBody({
      kind: 'tip',
      text: `Sent you ${name}`,
      meta: {
        txid,
        sats: 1,
        status: 'Incoming',
        memo: name,
        item: true,
        ...(itemOrigin ? { itemOrigin } : {}),
        ...(itemCollectionId ? { itemCollectionId } : {}),
        ...(Number.isInteger(args.itemOutputIndex) && args.itemOutputIndex! >= 0
          ? { itemOutputIndex: args.itemOutputIndex }
          : {}),
        asset: args.asset ?? { kind: 'collectable' },
      },
    })
  const base = itemMessage()
  const withProof = withOptionalProvenance(base, args.provenance)
  let packed = {
    ...withOptionalBeefB64(withProof.body, atomicBeef),
    provenanceInBox: withProof.provenanceInBox,
  }
  // Fat merged ancestry blows the 11k cap. Ship this hop (+ direct parents)
  // so BSV-21 settle does not fall back to WhatsOnChain.
  if (!packed.beefInBox && atomicBeef?.length) {
    const { inboxSubjectBeef } = await import('./beefCache')
    const lean = inboxSubjectBeef(atomicBeef, txid)
    if (lean?.length && lean.length < atomicBeef.length) {
      packed = {
        ...withOptionalBeefB64(withProof.body, lean),
        provenanceInBox: withProof.provenanceInBox,
      }
    }
  }
  // Identity before a second indexer walk. If both proofs cannot share the cap,
  // keep remittance and let this hop SPV-fetch the way omitted-beef already does.
  // Fungible custody is the Atomic BEEF — never drop it to keep provenance.
  if (args.provenance && !packed.provenanceInBox) {
    const proofOnly = withOptionalProvenance(base, args.provenance)
    if (proofOnly.provenanceInBox) {
      packed = {
        body: proofOnly.body,
        beefInBox: false,
        provenanceInBox: true,
      }
    } else {
      console.warn(
        '[messagebox] item remittance omitted — box cap; receiver identity falls back to indexer',
      )
    }
  }
  if (args.asset?.kind === 'fungible' && !packed.beefInBox) {
    console.warn(
      `[messagebox] BSV-21 AtomicBEEF omitted txid=${txid.slice(0, 12)} — payee cannot settle without an indexer`,
    )
  }

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
    if (deliveryReachedPeer(delivered.delivered)) {
      return {
        delivered: delivered.delivered,
        beefInBox: packed.beefInBox,
        provenanceInBox: packed.provenanceInBox,
      }
    }
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt))
  }
  return none
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
  chatRef?: boolean
}): Promise<PeerBeefNotifyResult> {
  const txid = args.txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid)) {
    return { delivered: 'local', beefInBox: false, provenanceInBox: false }
  }
  if (
    !args.remittance.derivationPrefix?.trim() ||
    !args.remittance.derivationSuffix?.trim()
  ) {
    return { delivered: 'local', beefInBox: false, provenanceInBox: false }
  }
  const sats =
    Number.isFinite(args.satoshis) && args.satoshis > 0
      ? Math.floor(args.satoshis)
      : 0
  let atomicBeef = args.atomicBeef
  if (atomicBeef?.length) {
    try {
      const active = (await import('./session')).getActiveWallet()
      if (active) {
        const { mergeLocalUnconfirmedAncestry, rememberBeefTree } = await import(
          './beefCache'
        )
        atomicBeef = await mergeLocalUnconfirmedAncestry(active, atomicBeef)
        rememberBeefTree(atomicBeef, txid)
      }
    } catch (error) {
      console.warn('[messagebox] payment ancestry completion skipped', error)
    }
  }
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
        ...(args.chatRef ? { chatRef: true } : {}),
      },
    }),
    atomicBeef,
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
    if (deliveryReachedPeer(delivered.delivered)) {
      return {
        delivered: delivered.delivered,
        beefInBox: packed.beefInBox,
        provenanceInBox: false,
      }
    }
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt))
  }
  return { delivered: 'local', beefInBox: false, provenanceInBox: false }
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
      }, box),
      body: JSON.stringify({ messageBox: 'inbox', messageIds }),
    })
  } catch {
    /* ignore */
  }
}
