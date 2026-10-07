/**
 * Off-device copy of the custody journal, beside the BRC-39 history object.
 *
 * Sealed with AES-GCM under HKDF(account root key) — no password, no Argon2 —
 * so it is cheap enough to replicate after every growth instead of waiting
 * for the debounced history push. Sync is pull → union → push-if-different:
 * since the journal is a grow-only set, a stale, partial, or older remote can
 * only add recipes, and no device can ever overwrite another's.
 */
import { PrivateKey } from '@bsv/sdk'
import { pinAccountKeyScope, type BoundAccountKeyScope } from './accountLocalKeys'
import { base64ToBytes, bytesToBase64 } from './base64Binary'
import {
  appendCustody,
  custodyEntries,
  custodyJournalRoot,
  onCustodyJournalGrew,
} from './custodyJournal'
import { resolveHistoryBackupBaseUrl } from './historyBackupPrefs'
import { ifMatchEtag } from './httpEtag'
import { signedIdentityFetch } from './identityRequestAuth'
import type { ActiveWallet } from './session'
import { getWalletRuntime } from './walletRuntime'

const HKDF_INFO = 'handcash custody journal v1'
const OBJECT = 'custody.journal'
const SYNC_DEBOUNCE_MS = 15_000
const RETRY_MS = 5 * 60_000

type SealedJournal = { v: 1; identityKey: string; root: string; iv: string; ciphertext: string }

export type CustodySyncResult =
  | { kind: 'off' }
  | { kind: 'synced'; pulled: number; pushed: boolean; root: string }
  | { kind: 'failed'; reason: string }

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function sealKey(rootKeyHex: string, identityKey: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(PrivateKey.fromHex(rootKeyHex.trim()).toArray('be', 32))
  const base = await crypto.subtle.importKey('raw', bufferOf(raw), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: bufferOf(new TextEncoder().encode(identityKey)),
      info: bufferOf(new TextEncoder().encode(HKDF_INFO)),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function sealCustodyJournal(
  rootKeyHex: string,
  identityKey: string,
  root: string,
  entries: readonly unknown[],
): Promise<SealedJournal> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plain = new TextEncoder().encode(JSON.stringify({ v: 1, e: entries }))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bufferOf(iv) },
    await sealKey(rootKeyHex, identityKey),
    bufferOf(plain),
  )
  return {
    v: 1,
    identityKey,
    root,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  }
}

/** Entries of a sealed journal; throws on a foreign or tampered object. */
export async function openCustodyJournal(
  rootKeyHex: string,
  identityKey: string,
  sealed: unknown,
): Promise<unknown[]> {
  const s = sealed as Partial<SealedJournal> | null
  if (!s || s.v !== 1 || typeof s.iv !== 'string' || typeof s.ciphertext !== 'string') {
    throw new Error('custody journal object is malformed')
  }
  if (s.identityKey !== identityKey) throw new Error('custody journal belongs to another identity')
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bufferOf(base64ToBytes(s.iv)) },
    await sealKey(rootKeyHex, identityKey),
    bufferOf(base64ToBytes(s.ciphertext)),
  )
  const body = JSON.parse(new TextDecoder().decode(plain)) as { e?: unknown }
  return Array.isArray(body.e) ? body.e : []
}

function objectUrl(identityKey: string): string | null {
  const base = resolveHistoryBackupBaseUrl()
  return base ? `${base}/v1/wallets/${encodeURIComponent(identityKey.trim())}/${OBJECT}` : null
}

function isCurrentWallet(active: ActiveWallet): boolean {
  return getWalletRuntime()?.instance === active
}

const inFlight = new Map<string, Promise<CustodySyncResult>>()

/** Pull, union, and push when the two sets differ. */
export async function syncCustodyJournal(
  active: ActiveWallet,
  reason: string,
): Promise<CustodySyncResult> {
  const owner = pinAccountKeyScope(active)
  const url = owner ? objectUrl(owner.identityKey) : null
  if (!owner || !url) return { kind: 'off' }
  const held = inFlight.get(url)
  if (held) return held
  const run = runSync(active, owner, url, reason).finally(() => inFlight.delete(url))
  inFlight.set(url, run)
  return run
}

/** What the host held after our last exchange; `etag: null` means absent. */
type RemoteState = { etag: string | null; root: string | null }
const lastRemote = new Map<string, RemoteState>()
const CAS_ATTEMPTS = 3

/** Pull and union. An unreadable object is reported, not merged: our set replaces it. */
async function pull(active: ActiveWallet, owner: BoundAccountKeyScope, url: string) {
  const got = await signedIdentityFetch(active.rootKeyHex, 'history', url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  })
  if (got.status === 404) return { remote: { etag: null, root: null }, pulled: 0 }
  if (!got.ok) throw new Error(`pull ${got.status}`)
  const etag = ifMatchEtag(got.headers.get('ETag'))
  const sealed = (await got.json().catch(() => null)) as SealedJournal | null
  const root = typeof sealed?.root === 'string' ? sealed.root : null
  if (root && root === custodyJournalRoot(owner)) return { remote: { etag, root }, pulled: 0 }
  try {
    const incoming = await openCustodyJournal(active.rootKeyHex, owner.identityKey, sealed)
    return { remote: { etag, root }, pulled: appendCustody(owner, incoming).added }
  } catch (err) {
    // Only this identity can sign a write, and the host keeps every version.
    console.error(
      `[custody-journal] remote object unreadable (${err instanceof Error ? err.message : String(err)}) — replacing with local set`,
    )
    return { remote: { etag, root: null }, pulled: 0 }
  }
}

async function runSync(
  active: ActiveWallet,
  owner: BoundAccountKeyScope,
  url: string,
  reason: string,
): Promise<CustodySyncResult> {
  const t0 = Date.now()
  let pulled = 0
  let pushed = false
  try {
    // Hot path: we know the host's state, so push conditionally without a read.
    let remote = reason === 'grew' ? lastRemote.get(url) : undefined
    for (let attempt = 0; ; attempt += 1) {
      if (!remote) {
        const got = await pull(active, owner, url)
        remote = got.remote
        pulled += got.pulled
        lastRemote.set(url, remote)
      }
      const root = custodyJournalRoot(owner)
      if (root === remote.root || !isCurrentWallet(active)) break
      const body = JSON.stringify(
        await sealCustodyJournal(active.rootKeyHex, owner.identityKey, root, custodyEntries(owner)),
      )
      const put = await signedIdentityFetch(active.rootKeyHex, 'history', url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(remote.etag ? { 'If-Match': remote.etag } : {}),
        },
        body,
      })
      if (put.ok) {
        const reply = (await put.json().catch(() => ({}))) as { etag?: unknown }
        const etag = typeof reply.etag === 'string' ? reply.etag : null
        // Without an etag the next push must read first.
        if (etag) lastRemote.set(url, { etag, root })
        else lastRemote.delete(url)
        pushed = true
        break
      }
      // Another device wrote first: read its set, union, try again.
      if ((put.status === 412 || put.status === 409) && attempt + 1 < CAS_ATTEMPTS) {
        lastRemote.delete(url)
        remote = undefined
        continue
      }
      lastRemote.delete(url)
      throw new Error(`push ${put.status}`)
    }
    const root = custodyJournalRoot(owner)
    if (pulled > 0 || pushed || Date.now() - t0 > 250) {
      console.info(
        `[custody-journal] backup ${reason} pulled=${pulled} pushed=${pushed} entries=${custodyEntries(owner).length} ` +
          `root=${root.slice(0, 12)} done ${Date.now() - t0}ms`,
      )
    }
    return { kind: 'synced', pulled, pushed, root }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[custody-journal] backup ${reason} failed: ${msg}`)
    return { kind: 'failed', reason: msg }
  }
}

let timer: ReturnType<typeof setTimeout> | null = null
let pendingReason = 'grew'

/** Debounced sync of the current wallet's journal; retries after a failure. */
export function scheduleCustodyJournalSync(reason = 'grew', delayMs = SYNC_DEBOUNCE_MS): void {
  pendingReason = reason
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    const active = getWalletRuntime()?.instance
    if (!active) return
    void syncCustodyJournal(active, pendingReason).then((r) => {
      if (r.kind === 'failed') scheduleCustodyJournalSync('retry', RETRY_MS)
    })
  }, delayMs)
}

let stop: (() => void) | null = null

/** Replicate after every growth of the current wallet's journal. */
export function startCustodyJournalBackup(): void {
  if (stop) return
  stop = onCustodyJournalGrew((owner) => {
    const active = getWalletRuntime()?.instance
    const current = pinAccountKeyScope(active)
    if (
      current &&
      current.identityKey === owner.identityKey &&
      current.accountIndex === owner.accountIndex &&
      current.chain === owner.chain
    ) {
      scheduleCustodyJournalSync('grew')
    }
  })
}

export function resetCustodyJournalBackupForTests(): void {
  if (timer) clearTimeout(timer)
  timer = null
  stop?.()
  stop = null
  inFlight.clear()
  lastRemote.clear()
}
