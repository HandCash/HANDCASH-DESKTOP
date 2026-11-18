/** HandCash extension carried by the authenticated BRC-100 bridge.
 * A one-time receiver key seals exported shares in transit. It never signs a
 * transaction. The decrypted source waits in memory for the user's review
 * (importWriteGrant chart, Packet F) and is saved only after they approve it;
 * then it goes to the existing preview/confirm flow.
 */
import { createActor, fromPromise, waitFor, type ActorRefFrom } from 'xstate'
import { importWriteGrantMachine, type ImportReviewDecision, type ImportWriteRefusal } from '../../machines/importWriteGrantMachine'
import { isOriginAllowed, requestActionApproval, withdrawActionPrompts } from '../permissions'
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
  /** Set by lock, disconnect or account change; a revoked receiver never writes. */
  revoked: boolean
  review?: ActorRefFrom<typeof importWriteGrantMachine>
}
const pending = new Map<string, Pending>()
const REVIEW_METHOD = 'completeHandCashImport'

/** A refused app write. `code` reaches the app; nothing was saved. */
export class ImportWriteRefused extends Error {
  readonly code: string
  constructor(refusal: ImportWriteRefusal) {
    const [code, message] = {
      denied: ['IMPORT_REVIEW_DENIED', 'The wallet owner did not approve saving these keys.'],
      timeout: ['IMPORT_REVIEW_EXPIRED', 'The import review expired. Connect again.'],
      revoked: ['IMPORT_REVIEW_REVOKED', 'The import was cancelled because the app disconnected or the wallet locked.'],
      unauthorized: ['IMPORT_REVIEW_REVOKED', 'Import connection expired or the receiving wallet changed. Connect again.'],
      failed: ['IMPORT_SAVE_FAILED', 'Could not save the encrypted import. Reconnect and try again, or import your exported keys in Settings.'],
    }[refusal]
    super(message)
    this.name = 'ImportWriteRefused'
    this.code = code
  }
}
const TTL = 5 * 60_000
const encoder = new TextEncoder()
const bytes = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const base64 = (b: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(b)))

/** Lock or account rebind: every receiver and pending review is refused. */
export function clearEncryptedImports(): void { revokeEncryptedImports() }

/** Disconnect / lapse for one host (or all): refuse its receivers and reviews. */
export function revokeEncryptedImports(host?: string): void {
  for (const [id, entry] of pending) {
    if (host && entry.origin !== host) continue
    entry.revoked = true
    entry.privateKey = null
    if (entry.review) {
      entry.review.send({ type: 'REVOKE' })
      withdrawActionPrompts(entry.origin, REVIEW_METHOD)
    }
    pending.delete(id)
  }
}

/** Pending reviews by host, metadata only (Connected Apps). */
export function pendingImportReviews(): Array<{ host: string; expiresAt: number }> {
  return [...pending.values()]
    .filter((e) => e.review && !e.revoked && e.review.getSnapshot().matches('pendingReview'))
    .map((e) => ({ host: e.origin, expiresAt: e.request.expiresAt }))
}

/**
 * The grant's scope, checked synchronously: this exact receiver still pending
 * and unrevoked, before its deadline, same account and network, and the host
 * still connected. Origin allowlisting is checked by the bridge as well.
 */
function authorized(entry: Pending): boolean {
  if (entry.revoked || pending.get(entry.request.id) !== entry) return false
  if (entry.request.expiresAt <= Date.now()) return false
  const active = getActiveWallet()
  if (!active || active.identityKey !== entry.request.identityKey || active.chain !== entry.request.chain) return false
  return isOriginAllowed(entry.origin)
}

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
    if (entry.request.expiresAt <= Date.now() || entry.request.identityKey !== active.identityKey ||
        entry.request.chain !== active.chain) pending.delete(id)
    else if (entry.origin === host && !entry.delivery) return entry.request
  }
  if (pending.size >= 8) throw new Error('Too many pending imports. Try again in a few minutes.')
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const current = activeIdentity()
  if (current.identityKey !== active.identityKey || current.chain !== active.chain) {
    throw new Error('The receiving wallet changed. Connect again.')
  }
  const request: HandCashImportRequest = {
    v: 1, id: crypto.randomUUID(), identityKey: active.identityKey, chain: active.chain,
    publicKey: base64(await crypto.subtle.exportKey('raw', pair.publicKey)), expiresAt: Date.now() + TTL,
  }
  pending.set(request.id, { request, origin: host, privateKey: pair.privateKey, revoked: false })
  if (typeof window !== 'undefined') window.setTimeout(() => {
    // Expiry ends the receiver; an in-flight review is refused, never left waiting.
    const entry = pending.get(request.id)
    if (entry?.review) {
      entry.review.send({ type: 'REVOKE' })
      withdrawActionPrompts(entry.origin, REVIEW_METHOD)
    }
    pending.delete(request.id)
  }, TTL)
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
  if (!entry || entry.revoked || entry.origin !== normalizeAppHost(origin) || entry.request.expiresAt <= Date.now() ||
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

/** One BRC-100 action prompt, bounded by the receiver's deadline. */
async function reviewDelivery(entry: Pending): Promise<ImportReviewDecision> {
  const left = entry.request.expiresAt - Date.now()
  if (left <= 0) return 'timeout'
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), left) })
  try {
    // The wallet writes the prompt's args; nothing the app sent describes the write.
    const decision = await Promise.race([
      requestActionApproval(entry.origin, REVIEW_METHOD, { identityKey: entry.request.identityKey, chain: entry.request.chain }),
      deadline,
    ])
    if (decision === 'timeout') withdrawActionPrompts(entry.origin, REVIEW_METHOD)
    return decision === 'allow' ? 'allow' : decision === 'timeout' ? 'timeout' : 'deny'
  } finally {
    clearTimeout(timer)
  }
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
    // The shares wait for review as parsed fields only; drop the raw buffer now.
    new Uint8Array(plaintext).fill(0)
    if (!authorized(entry)) throw new ImportWriteRefused('unauthorized')
    const secret = parsed.secret
    const guard = () => { if (!authorized(entry)) throw new ImportWriteRefused('unauthorized') }
    const review = createActor(importWriteGrantMachine.provide({
      actors: {
        review: fromPromise<ImportReviewDecision>(() => reviewDelivery(entry)),
        persist: fromPromise<unknown>(() => addImportedSource(secret, undefined, entry.request.identityKey, entry.request.chain, guard)),
      },
    }), { input: { authorized: () => authorized(entry) } })
    entry.review = review
    review.start()
    const done = await waitFor(review, (s) => s.status === 'done')
    entry.review = undefined
    const { receipt, refusal } = done.output!
    if (refusal) throw new ImportWriteRefused(refusal)
    const saved = receipt as Awaited<ReturnType<typeof addImportedSource>>
    const recovery = parseRecoveryHints(hints)
    if (recovery) rememberRecoveryHints(recovery)
    requestImportedSource(saved.source.id)
    openSetting('import')
    if (typeof window !== 'undefined') void window.handcash?.focusWindow?.().catch(() => undefined)
    return { sourceId: saved.source.id, saved: true, existing: saved.existing }
  } catch (err) {
    // Crypto and parsing errors can include secret material. Never surface them.
    if (err instanceof ImportWriteRefused) throw err
    // A revoke that lands mid-decryption nulls the key; report it as revoked.
    throw new ImportWriteRefused(entry.revoked ? 'revoked' : 'failed')
  } finally {
    entry.privateKey = null
    if (plaintext) new Uint8Array(plaintext).fill(0)
  }
}
