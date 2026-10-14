/**
 * Off-device copy of a grow-only journal, beside the BRC-39 history object.
 *
 * Sealed with AES-GCM under HKDF(account root key) — no password, no Argon2 —
 * so it is cheap enough to replicate after every growth instead of waiting
 * for the debounced history push. Sync is pull → union → push-if-different
 * with a conditional write: since a journal is a grow-only set, a stale,
 * partial, or older remote can only add entries, and no device can ever
 * overwrite another's.
 *
 * Each journal has its own object and HKDF label, so one key never opens
 * another journal's object.
 */
import { PrivateKey } from '@bsv/sdk'
import { pinAccountKeyScope, type BoundAccountKeyScope } from './accountLocalKeys'
import { base64ToBytes, bytesToBase64 } from './base64Binary'
import { resolveHistoryBackupBaseUrl } from './historyBackupPrefs'
import { ifMatchEtag } from './httpEtag'
import { signedIdentityFetch } from './identityRequestAuth'
import type { ActiveWallet } from './session'
import { getWalletRuntime } from './walletRuntime'

export type SealedJournal = { v: 1; identityKey: string; root: string; iv: string; ciphertext: string }

export type JournalSyncResult =
  | { kind: 'off' }
  | { kind: 'synced'; pulled: number; pushed: boolean; root: string }
  | { kind: 'failed'; reason: string }

export type GrowOnlyJournal = {
  /** Object name under `/v1/wallets/<identityKey>/`. */
  object: string
  /** HKDF info for the sealing key. */
  info: string
  /** Log tag, e.g. `custody-journal`. */
  tag: string
  debounceMs: number
  root: (owner: BoundAccountKeyScope) => string
  entries: (owner: BoundAccountKeyScope) => readonly unknown[]
  /** Union `incoming` into the local set; never throws on a foreign entry. */
  append: (owner: BoundAccountKeyScope, incoming: readonly unknown[]) => { added: number }
}

const RETRY_MS = 5 * 60_000
const CAS_ATTEMPTS = 3

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function sealKey(info: string, rootKeyHex: string, identityKey: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(PrivateKey.fromHex(rootKeyHex.trim()).toArray('be', 32))
  const base = await crypto.subtle.importKey('raw', bufferOf(raw), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: bufferOf(new TextEncoder().encode(identityKey)),
      info: bufferOf(new TextEncoder().encode(info)),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function sealJournal(
  info: string,
  rootKeyHex: string,
  identityKey: string,
  root: string,
  entries: readonly unknown[],
): Promise<SealedJournal> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plain = new TextEncoder().encode(JSON.stringify({ v: 1, e: entries }))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bufferOf(iv) },
    await sealKey(info, rootKeyHex, identityKey),
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
export async function openJournal(
  info: string,
  rootKeyHex: string,
  identityKey: string,
  sealed: unknown,
): Promise<unknown[]> {
  const s = sealed as Partial<SealedJournal> | null
  if (!s || s.v !== 1 || typeof s.iv !== 'string' || typeof s.ciphertext !== 'string') {
    throw new Error('journal object is malformed')
  }
  if (s.identityKey !== identityKey) throw new Error('journal belongs to another identity')
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bufferOf(base64ToBytes(s.iv)) },
    await sealKey(info, rootKeyHex, identityKey),
    bufferOf(base64ToBytes(s.ciphertext)),
  )
  const body = JSON.parse(new TextDecoder().decode(plain)) as { e?: unknown }
  return Array.isArray(body.e) ? body.e : []
}

/** What the host held after our last exchange; `etag: null` means absent. */
type RemoteState = { etag: string | null; root: string | null }

/** An account to sync without opening it: a displaced install's handover. */
export type JournalAccount = { rootKeyHex: string; owner: BoundAccountKeyScope }

export type JournalReplica = {
  /** Pull, union, and push when the two sets differ. */
  sync: (active: ActiveWallet, reason: string) => Promise<JournalSyncResult>
  /** Same, for an account that is not the open one; pushes even though it is not current. */
  syncAccount: (account: JournalAccount, reason: string) => Promise<JournalSyncResult>
  /** Debounced sync of the current wallet's journal; retries after a failure. */
  schedule: (reason?: string, delayMs?: number) => void
  /** Schedule only when `owner` is the open account. */
  scheduleFor: (owner: BoundAccountKeyScope, reason?: string) => void
  reset: () => void
}

export function journalReplica(journal: GrowOnlyJournal): JournalReplica {
  const inFlight = new Map<string, Promise<JournalSyncResult>>()
  const lastRemote = new Map<string, RemoteState>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let pendingReason = 'grew'

  const objectUrl = (identityKey: string): string | null => {
    const base = resolveHistoryBackupBaseUrl()
    return base ? `${base}/v1/wallets/${encodeURIComponent(identityKey.trim())}/${journal.object}` : null
  }

  /** Pull and union. An unreadable object is reported, not merged: our set replaces it. */
  const pull = async (rootKeyHex: string, owner: BoundAccountKeyScope, url: string) => {
    const got = await signedIdentityFetch(rootKeyHex, 'history', url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
    if (got.status === 404) return { remote: { etag: null, root: null }, pulled: 0 }
    if (!got.ok) throw new Error(`pull ${got.status}`)
    const etag = ifMatchEtag(got.headers.get('ETag'))
    const sealed = (await got.json().catch(() => null)) as SealedJournal | null
    const root = typeof sealed?.root === 'string' ? sealed.root : null
    if (root && root === journal.root(owner)) return { remote: { etag, root }, pulled: 0 }
    try {
      const incoming = await openJournal(journal.info, rootKeyHex, owner.identityKey, sealed)
      return { remote: { etag, root }, pulled: journal.append(owner, incoming).added }
    } catch (err) {
      // Only this identity can sign a write, and the host keeps every version.
      console.error(
        `[${journal.tag}] remote object unreadable (${err instanceof Error ? err.message : String(err)}) — replacing with local set`,
      )
      return { remote: { etag, root: null }, pulled: 0 }
    }
  }

  const runSync = async (
    rootKeyHex: string,
    owner: BoundAccountKeyScope,
    url: string,
    reason: string,
    stillCurrent: () => boolean,
  ): Promise<JournalSyncResult> => {
    const t0 = Date.now()
    let pulled = 0
    let pushed = false
    try {
      // Hot path: we know the host's state, so push conditionally without a read.
      let remote = reason === 'grew' ? lastRemote.get(url) : undefined
      for (let attempt = 0; ; attempt += 1) {
        if (!remote) {
          const got = await pull(rootKeyHex, owner, url)
          remote = got.remote
          pulled += got.pulled
          lastRemote.set(url, remote)
        }
        const root = journal.root(owner)
        if (root === remote.root || !stillCurrent()) break
        const body = JSON.stringify(
          await sealJournal(journal.info, rootKeyHex, owner.identityKey, root, journal.entries(owner)),
        )
        const put = await signedIdentityFetch(rootKeyHex, 'history', url, {
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
      const root = journal.root(owner)
      if (pulled > 0 || pushed || Date.now() - t0 > 250) {
        console.info(
          `[${journal.tag}] backup ${reason} pulled=${pulled} pushed=${pushed} entries=${journal.entries(owner).length} ` +
            `root=${root.slice(0, 12)} done ${Date.now() - t0}ms`,
        )
      }
      return { kind: 'synced', pulled, pushed, root }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[${journal.tag}] backup ${reason} failed: ${msg}`)
      return { kind: 'failed', reason: msg }
    }
  }

  const start = (
    rootKeyHex: string,
    owner: BoundAccountKeyScope | undefined,
    reason: string,
    stillCurrent: () => boolean,
  ): Promise<JournalSyncResult> => {
    const url = owner ? objectUrl(owner.identityKey) : null
    if (!owner || !url) return Promise.resolve({ kind: 'off' })
    const held = inFlight.get(url)
    if (held) return held
    const run = runSync(rootKeyHex, owner, url, reason, stillCurrent).finally(() => inFlight.delete(url))
    inFlight.set(url, run)
    return run
  }

  const sync = (active: ActiveWallet, reason: string): Promise<JournalSyncResult> =>
    start(active.rootKeyHex, pinAccountKeyScope(active), reason, () => getWalletRuntime()?.instance === active)

  const syncAccount = (account: JournalAccount, reason: string): Promise<JournalSyncResult> =>
    start(account.rootKeyHex, pinAccountKeyScope(account.owner), reason, () => true)

  const schedule = (reason = 'grew', delayMs = journal.debounceMs): void => {
    pendingReason = reason
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const active = getWalletRuntime()?.instance
      if (!active) return
      void sync(active, pendingReason).then((r) => {
        if (r.kind === 'failed') schedule('retry', RETRY_MS)
      })
    }, delayMs)
  }

  const scheduleFor = (owner: BoundAccountKeyScope, reason = 'grew'): void => {
    const current = pinAccountKeyScope(getWalletRuntime()?.instance)
    if (
      current &&
      current.identityKey === owner.identityKey &&
      current.accountIndex === owner.accountIndex &&
      current.chain === owner.chain
    ) {
      schedule(reason)
    }
  }

  const reset = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    inFlight.clear()
    lastRemote.clear()
  }

  return { sync, syncAccount, schedule, scheduleFor, reset }
}
