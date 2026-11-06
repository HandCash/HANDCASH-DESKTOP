/** HandCash extension carried by the authenticated BRC-100 bridge.
 * A one-time receiver key seals exported shares in transit. It never signs a
 * transaction. The source is saved for the existing preview/confirm flow.
 */
import { getActiveWallet } from '../session'
import { normalizeAppHost } from '../appIdentity'
import { addImportedSource } from './store'
import { parseImportSecret } from './importSource'
import { parseRecoveryHints, rememberRecoveryHints } from './recoveryHints'
import { requestImportedSource } from './importIntent'
import { openSetting } from '../navStore'

export type HandCashImportRequest = {
  v: 1
  id: string
  identityKey: string
  chain: string
  publicKey: string
  expiresAt: number
}
export type HandCashImportReceipt = { sourceId: string; saved: true; existing: boolean }
type Pending = {
  request: HandCashImportRequest
  origin: string
  privateKey: CryptoKey | null
  delivery?: Promise<HandCashImportReceipt>
  fingerprint?: string
}
const pending = new Map<string, Pending>()
const TTL = 5 * 60_000
const encoder = new TextEncoder()
const bytes = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const base64 = (b: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(b)))

export function clearEncryptedImports(): void { pending.clear() }

function activeIdentity(): { identityKey: string; chain: string } {
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the receiving wallet and try again.')
  return active
}

export async function beginHandCashImport(origin: string): Promise<HandCashImportRequest> {
  if (!origin) throw new Error('Connect from a HandCash origin first.')
  const active = activeIdentity()
  const host = normalizeAppHost(origin)
  for (const [id, entry] of pending) {
    if (entry.request.expiresAt <= Date.now() || entry.request.identityKey !== active.identityKey) pending.delete(id)
    else if (entry.origin === host && !entry.delivery) return entry.request
  }
  if (pending.size >= 8) throw new Error('Too many pending imports. Try again in a few minutes.')
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  if (activeIdentity().identityKey !== active.identityKey) throw new Error('The receiving wallet changed. Connect again.')
  const request: HandCashImportRequest = {
    v: 1, id: crypto.randomUUID(), identityKey: active.identityKey, chain: active.chain,
    publicKey: base64(await crypto.subtle.exportKey('raw', pair.publicKey)), expiresAt: Date.now() + TTL,
  }
  pending.set(request.id, { request, origin: host, privateKey: pair.privateKey })
  if (typeof window !== 'undefined') window.setTimeout(() => pending.delete(request.id), TTL)
  return request
}

/** Both sides authenticate the full receiver descriptor as AES-GCM AAD. */
export function handCashImportContext(request: HandCashImportRequest): string {
  return JSON.stringify(['HandCash-import-v1', request.id, request.identityKey, request.chain, request.publicKey, request.expiresAt])
}

export async function completeHandCashImport(origin: string, raw: unknown): Promise<HandCashImportReceipt> {
  if (!origin) throw new Error('Connect from a HandCash origin first.')
  const args = (raw ?? {}) as Record<string, unknown>
  const entry = typeof args.id === 'string' ? pending.get(args.id) : undefined
  const active = activeIdentity()
  if (!entry || entry.origin !== normalizeAppHost(origin) || entry.request.expiresAt <= Date.now() ||
      entry.request.identityKey !== active.identityKey || entry.request.chain !== active.chain) {
    throw new Error('Import connection expired or the receiving wallet changed. Connect again.')
  }
  if (typeof args.publicKey !== 'string' || args.publicKey.length > 128 ||
      typeof args.iv !== 'string' || args.iv.length > 32 ||
      typeof args.ciphertext !== 'string' || args.ciphertext.length > 32_768) {
    throw new Error('Invalid encrypted import.')
  }
  const fingerprint = JSON.stringify([args.publicKey, args.iv, args.ciphertext])
  if (entry.delivery) {
    if (entry.fingerprint !== fingerprint) throw new Error('This import request was already used.')
    return entry.delivery
  }
  entry.fingerprint = fingerprint
  entry.delivery = receive(entry, args as { publicKey: string; iv: string; ciphertext: string }, args.hints)
  // A lost HTTP response can be retried without saving twice or rescanning.
  return entry.delivery
}

async function receive(entry: Pending, args: { publicKey: string; iv: string; ciphertext: string }, hints: unknown): Promise<HandCashImportReceipt> {
  let plaintext: ArrayBuffer | undefined
  try {
    if (!entry.privateKey) throw new Error('Receiver key expired')
    const peer = await crypto.subtle.importKey('raw', bytes(args.publicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, entry.privateKey, 256)
    const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
    const context = encoder.encode(handCashImportContext(entry.request))
    const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(entry.request.id), info: context }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(args.iv), additionalData: context }, key, bytes(args.ciphertext))
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as Record<string, unknown>
    if (typeof body.cloud !== 'string' || typeof body.trustholder !== 'string') throw new Error('Invalid shares')
    const parsed = parseImportSecret('handcash', { primary: body.cloud, secondary: body.trustholder })
    if (!parsed.ok) throw new Error('Invalid shares')
    if (entry.request.expiresAt <= Date.now()) throw new Error('Request expired')
    const saved = await addImportedSource(parsed.secret, undefined, entry.request.identityKey, entry.request.chain)
    const current = activeIdentity()
    if (current.identityKey !== entry.request.identityKey || current.chain !== entry.request.chain) throw new Error('Wallet changed')
    const recovery = parseRecoveryHints(hints)
    if (recovery) rememberRecoveryHints(recovery)
    requestImportedSource(saved.source.id)
    openSetting('import')
    if (typeof window !== 'undefined') void window.handcash?.focusWindow?.().catch(() => undefined)
    return { sourceId: saved.source.id, saved: true, existing: saved.existing }
  } catch {
    // Crypto and parsing errors can include secret material. Never surface them.
    throw new Error('Could not save the encrypted import. Reconnect and try again, or import your exported keys in Settings.')
  } finally {
    entry.privateKey = null
    if (plaintext) new Uint8Array(plaintext).fill(0)
  }
}
