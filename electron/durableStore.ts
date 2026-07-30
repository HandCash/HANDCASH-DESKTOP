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

function readStore(): Store {
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

function writeStore(store: Store): void {
  const file = storePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Atomic-ish replace to reduce torn writes.
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

function canSeal(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** Seal vault payloads with OS keychain/DPAPI when available. */
function sealIfNeeded(key: string, value: string): string {
  if (!key.startsWith('handcash.brc100.vault')) return value
  if (value.startsWith(SEALED_PREFIX)) return value
  if (!canSeal()) return value
  try {
    const buf = safeStorage.encryptString(value)
    return SEALED_PREFIX + buf.toString('base64')
  } catch (err) {
    log.warn('safeStorage seal failed — storing unsealed vault', err)
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
    writeStore(store)
    return true
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
    writeStore(store)
    return true
  } catch (err) {
    log.error('durableRemove failed', err)
    return false
  }
}

export function durableSafeStorageAvailable(): boolean {
  return canSeal()
}
