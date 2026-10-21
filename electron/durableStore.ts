import fs from 'node:fs'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import log from 'electron-log'
import { isDiskFull, listTempFiles, removeTempFiles, writeFileAtomic } from './atomicFile.js'

type Store = Record<string, string>

const VAULT_KEY = 'handcash.brc100.vault.v1'
const VAULT_BACKUP_KEY = 'handcash.brc100.vault.backup.v1'
const VAULT_HISTORY_PREFIX = 'handcash.brc100.vault.history.'
const MAX_VAULT_HISTORY = 10
const SEALED_PREFIX = 'sealed:v1:'

function storePath(): string {
  return path.join(app.getPath('userData'), 'durable-prefs.json')
}

/**
 * The whole store, held in memory.
 *
 * The renderer reads these prefs through `ipcRenderer.sendSync`, which parks
 * the renderer thread until this process answers — no timers, no paint, and no
 * stall warning, because the watchdog cannot run either. Re-reading and
 * re-parsing the file per key therefore charged the renderer the cost of the
 * entire store for one lookup. On a working wallet this file reaches several
 * megabytes (item art, messages, activity, guard blobs), so ordinary preference
 * traffic froze the window outright.
 *
 * This process is the only writer, so memory cannot drift from disk.
 */
let cache: Store | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let retryDelayMs = 0
/**
 * Set when the store file exists but could not be read. Saving would replace
 * data this process never loaded, so nothing is written until a restart.
 */
let savingBlocked = false

/** Coalesce a burst of writes into one file replace. */
const FLUSH_DEBOUNCE_MS = 150
/** A failed save (a full disk) retries on its own, backing off to once a minute. */
const RETRY_MIN_MS = 2_000
const RETRY_MAX_MS = 60_000

/** The version each save replaces, kept as a hard link: the fallback if the store file is ever unreadable. */
function previousPath(): string {
  return `${storePath()}.previous`
}

type Candidate = { path: string; store: Store; mtimeMs: number }
type ReadResult =
  | { kind: 'ok'; candidate: Candidate }
  | { kind: 'missing' }
  | { kind: 'corrupt' }
  | { kind: 'unreadable'; error: unknown }

function parseStore(raw: string): Store | null {
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const out: Store = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

function readCandidate(file: string): ReadResult {
  let raw: string
  let mtimeMs: number
  try {
    raw = fs.readFileSync(file, 'utf8')
    mtimeMs = fs.statSync(file).mtimeMs
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable', error }
  }
  try {
    const store = parseStore(raw)
    return store ? { kind: 'ok', candidate: { path: file, store, mtimeMs } } : { kind: 'corrupt' }
  } catch {
    return { kind: 'corrupt' }
  }
}

/** The most recently written copy; the store file wins a tie. */
function newest(candidates: readonly Candidate[]): Candidate | null {
  let best: Candidate | null = null
  for (const candidate of candidates) if (!best || candidate.mtimeMs > best.mtimeMs) best = candidate
  return best
}

/** Move an unparseable store file aside, never deleting it, so the next save cannot replace its bytes. */
function quarantine(file: string): void {
  const aside = `${file}.corrupt-${Date.now()}`
  try {
    fs.renameSync(file, aside)
    log.error('durable store file is corrupt; kept it as', path.basename(aside))
  } catch (err) {
    savingBlocked = true
    log.error('durable store file is corrupt and could not be moved aside; saving is off', err)
  }
}

/**
 * Load the newest complete copy: the store file, the previous version, or a
 * temp file that finished syncing but was never renamed in (a crash in
 * between). Leftover temp files are deleted only once a complete copy is the
 * store file, so none of them can be the only good copy.
 */
function loadFromDisk(): Store {
  const file = storePath()
  const main = readCandidate(file)
  const temps = listTempFiles(path.dirname(file), path.basename(file))
  const fallbacks = [previousPath(), ...temps.map((temp) => temp.path)]
    .map(readCandidate)
    .flatMap((read) => (read.kind === 'ok' ? [read.candidate] : []))

  if (main.kind === 'unreadable') {
    savingBlocked = true
    log.error('durable store file could not be read; saving is off so it is not replaced', main.error)
    return { ...(newest(fallbacks)?.store ?? {}) }
  }
  if (main.kind === 'corrupt') quarantine(file)

  const best = newest(main.kind === 'ok' ? [main.candidate, ...fallbacks] : fallbacks)
  if (!best) {
    if (main.kind === 'missing' && removeTempFiles(temps) > 0) log.info('durable store removed incomplete temp files')
    return {}
  }
  if (best.path !== file) {
    log.warn('durable store restored from', path.basename(best.path))
    if (!persist(best.store)) return best.store
  }
  const removed = removeTempFiles(temps)
  if (removed > 0) log.info('durable store removed leftover temp files', removed)
  return best.store
}

function readStore(): Store {
  if (!cache) cache = loadFromDisk()
  return cache
}

/**
 * Replace the file atomically. A failure, a full disk included, leaves the
 * last saved file as it was.
 *
 * Serialized compact: pretty-printing added roughly a fifth to a multi-megabyte
 * write for a machine-read file, and every byte of it is paid while a renderer
 * may be parked on the next synchronous read.
 */
function persist(store: Store): boolean {
  if (savingBlocked) {
    log.error('durable store not saved: the file on disk could not be read, so it is left as it is')
    return false
  }
  const file = storePath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const result = writeFileAtomic(file, JSON.stringify(store), { previous: previousPath() })
    if (!result.directorySynced) log.warn('durable store saved, but its folder could not be synced', result.error)
    return true
  } catch (err) {
    if (isDiskFull(err)) log.error('durable store not saved: the disk is full; the last saved file is unchanged', err)
    else log.error('durable store flush failed; the last saved file is unchanged', err)
    return false
  }
}

function clearFlushTimer(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}

function scheduleRetry(): void {
  if (savingBlocked || flushTimer) return
  retryDelayMs = Math.min(retryDelayMs > 0 ? retryDelayMs * 2 : RETRY_MIN_MS, RETRY_MAX_MS)
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushDurableStore()
  }, retryDelayMs)
}

export function flushDurableStore(): boolean {
  clearFlushTimer()
  if (!cache) return true
  if (persist(cache)) {
    retryDelayMs = 0
    return true
  }
  scheduleRetry()
  return false
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushDurableStore()
  }, FLUSH_DEBOUNCE_MS)
}

/**
 * `sync` is for state we cannot lose to a crash inside the debounce window —
 * the vault and a factory reset. Caches and prefs ride the debounce.
 *
 * A sync write takes a copy of the store and only becomes what reads see once
 * it is on disk, so a refused write is not served from memory or saved later.
 */
function writeStore(store: Store, opts?: { sync?: boolean }): boolean {
  if (opts?.sync === true) {
    if (!persist(store)) return false
    cache = store
    clearFlushTimer()
    retryDelayMs = 0
    return true
  }
  cache = store
  scheduleFlush()
  return true
}

function isVaultKey(key: string): boolean {
  return key.startsWith('handcash.brc100.vault')
}

function requiresCommittedWrite(key: string): boolean {
  // Recoverable signed bodies, outboxes, input ownership, authentication
  // enrollment and published identity proofs must reach disk before the
  // renderer receives success.
  return isVaultKey(key) || /^(?:handcash\.wallet\.(?:signedChequeArchive|pendingMinerOutbox|utxoLocks)|handcash\.brc29\.pendingOutbox|handcash\.item\.pendingOutbox|handcash\.brc100\.deviceDek|handcash\.createdBeef|handcash\.autoPayReservations|handcash\.toolboxDatabasePointer|handcash\.publicIdentities|handcash\.issuerIdentities|handcash\.custodyJournal)/.test(key)
}

function canSeal(): boolean {
  try {
    return safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
  } catch {
    return false
  }
}

const VAULT_SEAL_STATUS_KEY = 'handcash.brc100.vaultSealStatus'

function setVaultSealStatus(status: 'sealed' | 'unsealed'): void {
  try {
    writeStore({ ...readStore(), [VAULT_SEAL_STATUS_KEY]: status }, { sync: true })
  } catch (err) {
    log.warn('could not persist vault seal status', err)
  }
}

/** Seal vault payloads with OS keychain/DPAPI when available. */
function sealIfNeeded(key: string, value: string): string {
  if (!key.startsWith('handcash.brc100.vault')) return value
  if (value.startsWith(SEALED_PREFIX)) return value
  if (!canSeal()) {
    if (key === VAULT_KEY) setVaultSealStatus('unsealed')
    return value
  }
  try {
    const buf = safeStorage.encryptString(value)
    if (key === VAULT_KEY) setVaultSealStatus('sealed')
    return SEALED_PREFIX + buf.toString('base64')
  } catch (err) {
    log.warn('safeStorage seal failed — storing unsealed vault', err)
    if (key === VAULT_KEY) setVaultSealStatus('unsealed')
    return value
  }
}

function unsealIfNeeded(key: string, value: string): string {
  if (!key.startsWith('handcash.brc100.vault')) return value
  if (!value.startsWith(SEALED_PREFIX)) return value
  if (!canSeal()) {
    log.error('Vault is OS-sealed but safeStorage is unavailable')
    throw new Error('Wallet vault is locked by the OS keychain and cannot be opened.')
  }
  try {
    const b64 = value.slice(SEALED_PREFIX.length)
    return safeStorage.decryptString(Buffer.from(b64, 'base64'))
  } catch (err) {
    log.error('safeStorage unseal failed', err)
    throw new Error('Could not decrypt wallet vault from OS keychain.')
  }
}

function pruneVaultHistory(store: Store): void {
  const keys = Object.keys(store)
    .filter((k) => k.startsWith(VAULT_HISTORY_PREFIX))
    .sort()
  while (keys.length > MAX_VAULT_HISTORY) {
    const oldest = keys.shift()
    if (oldest) delete store[oldest]
  }
}

function archiveVaultSnapshot(store: Store, previousRaw: string): void {
  store[VAULT_BACKUP_KEY] = previousRaw
  store[`${VAULT_HISTORY_PREFIX}${Date.now()}`] = previousRaw
  pruneVaultHistory(store)
}

export function durableGet(key: string): string | null {
  if (typeof key !== 'string' || !key) return null
  try {
    const raw = readStore()[key]
    if (raw == null) return null
    return unsealIfNeeded(key, raw)
  } catch (err) {
    log.error('durableGet failed', key, err)
    return null
  }
}

export function durableSet(
  key: string,
  value: string,
  opts?: { allowVaultIdentityReplace?: boolean },
): boolean {
  if (typeof key !== 'string' || !key || typeof value !== 'string') return false
  try {
    const sync = requiresCommittedWrite(key)
    const sealed = sealIfNeeded(key, value)
    const store = sync ? { ...readStore() } : readStore()

    if (key === VAULT_KEY && typeof store[key] === 'string') {
      let prevPlain: string
      try {
        prevPlain = unsealIfNeeded(key, store[key])
      } catch {
        log.warn('durableSet could not unseal previous vault — refusing write')
        return false
      }
      try {
        const prev = JSON.parse(prevPlain) as { identityKey?: string }
        const next = JSON.parse(value) as { identityKey?: string }
        if (
          typeof prev.identityKey === 'string' &&
          typeof next.identityKey === 'string' &&
          prev.identityKey !== next.identityKey
        ) {
          if (!opts?.allowVaultIdentityReplace) {
            log.error('durableSet blocked vault identity overwrite', {
              previousPrefix: prev.identityKey.slice(0, 12),
              nextPrefix: next.identityKey.slice(0, 12),
            })
            return false
          }
          log.warn('durableSet allowing vault identity replace (recovery)', {
            previousPrefix: prev.identityKey.slice(0, 12),
            nextPrefix: next.identityKey.slice(0, 12),
          })
        }
        archiveVaultSnapshot(store, store[key])
      } catch (err) {
        log.warn('durableSet vault guard parse failed — refusing write', err)
        return false
      }
    }

    store[key] = sealed
    return writeStore(store, { sync })
  } catch (err) {
    log.error('durableSet failed', err)
    return false
  }
}

export function durableRemove(key: string): boolean {
  if (typeof key !== 'string' || !key) return false
  try {
    if (!(key in readStore())) return true
    const sync = requiresCommittedWrite(key)
    const store = sync ? { ...readStore() } : readStore()
    if (key === VAULT_KEY && typeof store[key] === 'string') {
      archiveVaultSnapshot(store, store[key])
      log.warn('durableRemove vault.v1 — preserved backup + history')
    }
    delete store[key]
    return writeStore(store, { sync })
  } catch (err) {
    log.error('durableRemove failed', err)
    return false
  }
}

export function durableSafeStorageAvailable(): boolean {
  return canSeal()
}

/**
 * Keys that intentionally survive wipe (device prefs, not wallet state).
 * Keep in sync with `src/wallet/wipePolicy.ts`.
 */
const WIPE_SURVIVE_KEYS = new Set([
  'handcash.appearance',
  'handcash.sfx.enabled',
  'handcash.logs.uploadUrl',
  'handcash.update.mode',
])

/** Identity-scoped BRC-29 change derivations; see `wipePolicy.ts`. */
const WIPE_SURVIVE_PREFIXES = ['handcash.brc100.derivedChangeEcho.v1']

function shouldWipeHandcashKey(key: string): boolean {
  if (!key.startsWith('handcash.')) return false
  if (WIPE_SURVIVE_KEYS.has(key)) return false
  return !WIPE_SURVIVE_PREFIXES.some((prefix) => key.startsWith(prefix))
}

/**
 * Factory-reset wallet prefs: vault, backups, history, friends, apps, caches,
 * outboxes, etc. Does not touch device prefs (appearance / sfx / update /
 * log-upload URL).
 *
 * Must clear every `handcash.*` wallet-state key — not only `handcash.brc100.*`.
 * Fungibles list, BRC-29 outbox, and remittance maps used other prefixes and
 * survived wipe, so a new wallet painted the previous King token and replayed
 * foreign activity.
 */
export function durableWipeWallet(): { removed: number } {
  try {
    const store = { ...readStore() }
    let removed = 0
    for (const key of Object.keys(store)) {
      if (shouldWipeHandcashKey(key)) {
        delete store[key]
        removed++
      }
    }
    if (!writeStore(store, { sync: true })) throw new Error('Could not save the wallet reset to disk')
    log.warn('durableWipeWallet removed keys', removed)
    return { removed }
  } catch (err) {
    log.error('durableWipeWallet failed', err)
    throw err
  }
}
