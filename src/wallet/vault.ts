/**
 * Guardrails so we never silently mint a second root key over an existing wallet.
 *
 * Chart concern: vault lifecycle is create-once / unlock / rewrap-password.
 * IndexedDB (wallet-toolbox) can retain UTXOs under an older identityKey if a
 * new vault is created — that is what emptied balances after storage migrations.
 */
import { PrivateKey } from '@bsv/sdk'
import { durableGetItem, durableSetItem } from './durableStorage.js'

const VAULT_KEY = 'handcash.brc100.vault.v1'
/** Last displaced vault ciphertext (full record) — recovery aid only. */
const VAULT_BACKUP_KEY = 'handcash.brc100.vault.backup.v1'
/** Append-only meta about vault writes (no secrets). */
const VAULT_AUDIT_KEY = 'handcash.brc100.vault.audit.v1'
const TOOLBOX_DB = 'wallet-toolbox-mainnet'

export type Chain = 'main' | 'test'

export type VaultRecord = {
  version: 1
  chain: Chain
  handle: string
  identityKey: string
  address: string
  /** AES-GCM ciphertext of rootKeyHex, base64 */
  ciphertext: string
  iv: string
  salt: string
}

export type VaultAuditEntry = {
  at: number
  action: 'create' | 'password' | 'blocked-create' | 'blocked-overwrite'
  identityKeyPrefix: string
  previousIdentityKeyPrefix?: string
  detail?: string
}

type ToolboxUserRow = {
  userId?: number
  identityKey?: string
}

function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const b of u8) s += String.fromCharCode(b)
  return btoa(s)
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: toBufferSource(salt), iterations: 210_000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function readVaultRaw(): string | null {
  return durableGetItem(VAULT_KEY)
}

function appendAudit(entry: VaultAuditEntry): void {
  try {
    const raw = durableGetItem(VAULT_AUDIT_KEY)
    const list: VaultAuditEntry[] = raw ? (JSON.parse(raw) as VaultAuditEntry[]) : []
    if (!Array.isArray(list)) {
      durableSetItem(VAULT_AUDIT_KEY, JSON.stringify([entry]))
      return
    }
    list.push(entry)
    durableSetItem(VAULT_AUDIT_KEY, JSON.stringify(list.slice(-50)))
  } catch {
    // audit must never block wallet ops
  }
}

function prefixIk(identityKey: string | undefined): string {
  return identityKey && identityKey.length >= 12 ? identityKey.slice(0, 12) : 'unknown'
}

/** Snapshot current vault before any write that could displace it. */
function backupExistingVault(reason: string): void {
  const existing = readVaultRaw()
  if (!existing) return
  try {
    durableSetItem(VAULT_BACKUP_KEY, existing)
    const parsed = JSON.parse(existing) as VaultRecord
    appendAudit({
      at: Date.now(),
      action: 'password',
      identityKeyPrefix: prefixIk(parsed.identityKey),
      detail: `backup:${reason}`,
    })
  } catch {
    // keep going — write path will still refuse identity changes
  }
}

/**
 * Persist vault. Refuses changing identityKey once a vault exists.
 * Password rewrap keeps the same identityKey and is allowed.
 */
function persistVault(record: VaultRecord, action: 'create' | 'password'): void {
  const existingRaw = readVaultRaw()
  if (existingRaw) {
    let previous: VaultRecord
    try {
      previous = JSON.parse(existingRaw) as VaultRecord
    } catch {
      throw new Error('Existing wallet data is unreadable. Refusing to overwrite keys.')
    }
    if (previous.identityKey !== record.identityKey) {
      appendAudit({
        at: Date.now(),
        action: 'blocked-overwrite',
        identityKeyPrefix: prefixIk(record.identityKey),
        previousIdentityKeyPrefix: prefixIk(previous.identityKey),
        detail: 'identity-mismatch',
      })
      throw new Error(
        'Refusing to overwrite wallet keys with a different identity. Unlock the existing wallet instead.',
      )
    }
    backupExistingVault(action)
  } else if (action !== 'create') {
    throw new Error('No wallet found')
  }

  durableSetItem(VAULT_KEY, JSON.stringify(record))
  appendAudit({
    at: Date.now(),
    action,
    identityKeyPrefix: prefixIk(record.identityKey),
    previousIdentityKeyPrefix: existingRaw
      ? prefixIk((JSON.parse(existingRaw) as VaultRecord).identityKey)
      : undefined,
  })
}

export function hasVault(): boolean {
  return readVaultRaw() !== null
}

export function readVaultMeta(): Pick<VaultRecord, 'handle' | 'identityKey' | 'address' | 'chain'> | null {
  const raw = readVaultRaw()
  if (!raw) return null
  const parsed = JSON.parse(raw) as VaultRecord
  return {
    handle: parsed.handle,
    identityKey: parsed.identityKey,
    address: parsed.address,
    chain: parsed.chain,
  }
}

export function readVaultBackupMeta(): Pick<
  VaultRecord,
  'handle' | 'identityKey' | 'address' | 'chain'
> | null {
  const raw = durableGetItem(VAULT_BACKUP_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as VaultRecord
    return {
      handle: parsed.handle,
      identityKey: parsed.identityKey,
      address: parsed.address,
      chain: parsed.chain,
    }
  } catch {
    return null
  }
}

export function normalizeHandle(input: string): string {
  const cleaned = input.trim().replace(/^\$/, '').toLowerCase().replace(/[^a-z0-9_]/g, '')
  if (cleaned.length < 3) throw new Error('Handle must be at least 3 characters')
  return cleaned
}

/** Local vault label only — not a HandCash $handle. */
const LOCAL_WALLET_LABEL = 'wallet'

/** Identities already present in the toolbox IndexedDB (UTXO owners). */
export async function listToolboxIdentityKeys(): Promise<string[]> {
  if (typeof indexedDB === 'undefined') return []

  // Prefer databases() so we never create/upgrade an empty toolbox DB.
  try {
    if (typeof indexedDB.databases === 'function') {
      const dbs = await indexedDB.databases()
      if (!dbs.some((d) => d.name === TOOLBOX_DB)) return []
    }
  } catch {
    // fall through to open attempt
  }

  return new Promise((resolve) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(TOOLBOX_DB)
    } catch {
      resolve([])
      return
    }
    req.onerror = () => resolve([])
    req.onupgradeneeded = () => {
      // DB did not exist — abort so we do not create a blank toolbox DB.
      try {
        req.transaction?.abort()
      } catch {
        // ignore
      }
      resolve([])
    }
    req.onsuccess = () => {
      const db = req.result
      // If we just created it via a race, treat as empty and close.
      if (!db.objectStoreNames.contains('users')) {
        db.close()
        resolve([])
        return
      }
      try {
        const tx = db.transaction('users', 'readonly')
        const getAll = tx.objectStore('users').getAll()
        getAll.onerror = () => {
          db.close()
          resolve([])
        }
        getAll.onsuccess = () => {
          const rows = (getAll.result ?? []) as ToolboxUserRow[]
          const keys = rows
            .map((r) => r.identityKey)
            .filter((k): k is string => typeof k === 'string' && k.length > 0)
          db.close()
          resolve(keys)
        }
      } catch {
        db.close()
        resolve([])
      }
    }
  })
}

/**
 * True when toolbox DB has wallet users but durable vault is missing — creating
 * a new vault would orphan those UTXOs (the failure mode from storage migrations).
 */
export async function hasOrphanedToolboxWallet(): Promise<boolean> {
  if (hasVault()) return false
  const keys = await listToolboxIdentityKeys()
  return keys.length > 0
}

export async function assertSafeToCreateVault(): Promise<void> {
  if (hasVault()) {
    appendAudit({
      at: Date.now(),
      action: 'blocked-create',
      identityKeyPrefix: prefixIk(readVaultMeta()?.identityKey),
      detail: 'vault-exists',
    })
    throw new Error('A wallet already exists on this device. Unlock it instead of creating a new one.')
  }
  const toolboxKeys = await listToolboxIdentityKeys()
  if (toolboxKeys.length > 0) {
    appendAudit({
      at: Date.now(),
      action: 'blocked-create',
      identityKeyPrefix: prefixIk(toolboxKeys[0]),
      detail: `toolbox-users:${toolboxKeys.length}`,
    })
    throw new Error(
      'This device already has wallet funds under another key. Creating a new wallet is blocked so those keys are not replaced. Restore the original wallet backup if you have one.',
    )
  }
}

export async function createVault(args: {
  password: string
  chain: Chain
  /** @deprecated local DB label only; unused by UI */
  handle?: string
}): Promise<{ rootKeyHex: string; record: VaultRecord }> {
  await assertSafeToCreateVault()

  const handle = args.handle ? normalizeHandle(args.handle) : LOCAL_WALLET_LABEL
  if (args.password.length < 8) throw new Error('Password must be at least 8 characters')

  const root = PrivateKey.fromRandom()
  const rootKeyHex = root.toHex()
  const identityKey = root.toPublicKey().toString()
  const address = root.toAddress()

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(args.password, salt)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(rootKeyHex),
  )

  const record: VaultRecord = {
    version: 1,
    chain: args.chain,
    handle,
    identityKey,
    address,
    ciphertext: b64(ciphertext),
    iv: b64(iv),
    salt: b64(salt),
  }
  persistVault(record, 'create')
  return { rootKeyHex, record }
}

export async function unlockVault(password: string): Promise<{ rootKeyHex: string; record: VaultRecord }> {
  const raw = readVaultRaw()
  if (!raw) throw new Error('No wallet found')
  const record = JSON.parse(raw) as VaultRecord
  const key = await deriveKey(password, fromB64(record.salt))
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBufferSource(fromB64(record.iv)) },
      key,
      toBufferSource(fromB64(record.ciphertext)),
    )
    const rootKeyHex = new TextDecoder().decode(plain)
    PrivateKey.fromHex(rootKeyHex)
    return { rootKeyHex, record }
  } catch {
    throw new Error('Incorrect password')
  }
}

export async function changeVaultPassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (newPassword.length < 8) throw new Error('Password must be at least 8 characters')
  if (currentPassword === newPassword) {
    throw new Error('New password must be different from your current password')
  }

  const { rootKeyHex, record } = await unlockVault(currentPassword)

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(newPassword, salt)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(rootKeyHex),
  )

  const updated: VaultRecord = {
    ...record,
    ciphertext: b64(ciphertext),
    iv: b64(iv),
    salt: b64(salt),
  }
  // Same identityKey — persistVault allows rewrap, backs up previous ciphertext.
  persistVault(updated, 'password')
}
