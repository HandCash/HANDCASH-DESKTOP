import fs from 'node:fs'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import log from 'electron-log'

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

/** Coalesce a burst of writes into one file replace. */
const FLUSH_DEBOUNCE_MS = 150

function loadFromDisk(): Store {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Store = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

function readStore(): Store {
  if (!cache) cache = loadFromDisk()
  return cache
}

/**
 * Replace the file from memory.
 *
 * Serialized compact: pretty-printing added roughly a fifth to a multi-megabyte
 * write for a machine-read file, and every byte of it is paid while a renderer
 * may be parked on the next synchronous read.
 */
export function flushDurableStore(): boolean {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (!cache) return true
  try {
    const file = storePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // Atomic-ish replace to reduce torn writes.
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch (err) {
    log.error('durable store flush failed', err)
    return false
  }
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
 */
function writeStore(store: Store, opts?: { sync?: boolean }): boolean {
  cache = store
  if (opts?.sync === true) return flushDurableStore()
  scheduleFlush()
  return true
}

function isVaultKey(key: string): boolean {
  return key.startsWith('handcash.brc100.vault')
}

function canSeal(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

const VAULT_SEAL_STATUS_KEY = 'handcash.brc100.vaultSealStatus'

function setVaultSealStatus(status: 'sealed' | 'unsealed'): void {
  try {
    const store = readStore()
    store[VAULT_SEAL_STATUS_KEY] = status
    writeStore(store, { sync: true })
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
    const store = readStore()

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

    store[key] = sealIfNeeded(key, value)
    return writeStore(store, { sync: isVaultKey(key) })
  } catch (err) {
    log.error('durableSet failed', err)
    return false
  }
}

export function durableRemove(key: string): boolean {
  if (typeof key !== 'string' || !key) return false
  try {
    const store = readStore()
    if (!(key in store)) return true
    if (key === VAULT_KEY && typeof store[key] === 'string') {
      archiveVaultSnapshot(store, store[key])
      log.warn('durableRemove vault.v1 — preserved backup + history')
    }
    delete store[key]
    return writeStore(store, { sync: isVaultKey(key) })
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

function shouldWipeHandcashKey(key: string): boolean {
  if (!key.startsWith('handcash.')) return false
  return !WIPE_SURVIVE_KEYS.has(key)
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
    const store = readStore()
    let removed = 0
    for (const key of Object.keys(store)) {
      if (shouldWipeHandcashKey(key)) {
        delete store[key]
        removed++
      }
    }
    writeStore(store, { sync: true })
    log.warn('durableWipeWallet removed keys', removed)
    return { removed }
  } catch (err) {
    log.error('durableWipeWallet failed', err)
    throw err
  }
}
