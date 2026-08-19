/**
 * Vault custody: password-wrapped root key + BIP39 mnemonic, durable across origins,
 * OS-sealed at rest when Electron safeStorage is available.
 *
 * Lifecycle: create-once (with recovery phrase) | restore-from-phrase | unlock | rewrap-password.
 * Never mint a second root while toolbox UTXOs or an existing vault identity exist.
 */
import { Hash, HD, Mnemonic, PrivateKey } from '@bsv/sdk'
import { durableGetItem, durableSetItem } from './durableStorage.js'
import { validatePassword } from './passwordPolicy.js'

/** BRC-75 (default) or pre-BRC-75 HD master from BIP39 seed. */
export type MnemonicScheme = 'brc-75' | 'legacy-hd'

const VAULT_KEY = 'handcash.brc100.vault.v1'
const VAULT_BACKUP_KEY = 'handcash.brc100.vault.backup.v1'
const VAULT_AUDIT_KEY = 'handcash.brc100.vault.audit.v1'
const TOOLBOX_DB = 'wallet-toolbox-mainnet'

export type Chain = 'main' | 'test'

export type VaultRecord = {
  version: 1 | 2
  chain: Chain
  handle: string
  identityKey: string
  address: string
  /** AES-GCM ciphertext — v1: rootKeyHex string; v2: JSON { rootKeyHex, mnemonic } */
  ciphertext: string
  iv: string
  salt: string
  /** Present on v2+ wallets created/restored with BIP39. */
  hasMnemonic?: boolean
}

export type UnlockedVault = {
  rootKeyHex: string
  mnemonic: string | null
  record: VaultRecord
}

export type VaultAuditEntry = {
  at: number
  action: 'create' | 'restore' | 'password' | 'blocked-create' | 'blocked-overwrite' | 'mismatch-warn'
  identityKeyPrefix: string
  previousIdentityKeyPrefix?: string
  detail?: string
}

export type ToolboxMismatch = {
  vaultIdentityKey: string
  toolboxIdentityKeys: string[]
  /** True when vault identity is absent from toolbox but other identities exist. */
  orphanedFundsLikely: boolean
}

type ToolboxUserRow = {
  userId?: number
  identityKey?: string
}

type VaultSecretV2 = {
  rootKeyHex: string
  mnemonic: string
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

function persistVault(
  record: VaultRecord,
  action: 'create' | 'restore' | 'password',
  opts?: { allowIdentityReplace?: boolean },
): void {
  const existingRaw = readVaultRaw()
  if (existingRaw) {
    let previous: VaultRecord
    try {
      previous = JSON.parse(existingRaw) as VaultRecord
    } catch {
      throw new Error('Existing wallet data is unreadable. Refusing to overwrite keys.')
    }
    if (previous.identityKey !== record.identityKey) {
      if (!opts?.allowIdentityReplace) {
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
    }
    backupExistingVault(action)
  } else if (action === 'password') {
    throw new Error('No wallet found')
  }

  const payload = JSON.stringify(record)
  const wrote = durableSetItem(VAULT_KEY, payload, {
    allowVaultIdentityReplace: Boolean(opts?.allowIdentityReplace),
  })
  const stored = durableGetItem(VAULT_KEY)
  if (!wrote || stored == null) {
    throw new Error('Failed to persist wallet vault. Keys were not changed.')
  }
  try {
    const storedRecord = JSON.parse(stored) as VaultRecord
    if (storedRecord.identityKey !== record.identityKey) {
      throw new Error('Failed to persist wallet vault. Keys were not changed.')
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('Failed to persist')) throw err
    throw new Error('Failed to persist wallet vault. Keys were not changed.')
  }

  appendAudit({
    at: Date.now(),
    action,
    identityKeyPrefix: prefixIk(record.identityKey),
    previousIdentityKeyPrefix: existingRaw
      ? prefixIk((JSON.parse(existingRaw) as VaultRecord).identityKey)
      : undefined,
    detail: opts?.allowIdentityReplace ? 'recovery-replace' : undefined,
  })
}

type MnemonicDerived = {
  rootKeyHex: string
  identityKey: string
  address: string
  mnemonic: string
  scheme: MnemonicScheme
}

function normalizeMnemonic(mnemonic: string): Mnemonic {
  const m = Mnemonic.fromString(mnemonic.trim().toLowerCase().replace(/\s+/g, ' '))
  if (!m.check()) throw new Error('Invalid recovery phrase')
  return m
}

function derivedFromPrivateKey(
  key: PrivateKey,
  mnemonic: string,
  scheme: MnemonicScheme,
): MnemonicDerived {
  return {
    rootKeyHex: key.toHex(),
    identityKey: key.toPublicKey().toString(),
    address: key.toAddress(),
    mnemonic,
    scheme,
  }
}

/**
 * BRC-75 — BIP39 mnemonic → seed → SHA-256(seed) as the master private key.
 * New wallets use 128-bit entropy (12 words).
 */
export function rootKeyFromMnemonicBrc75(mnemonic: string, passphrase = ''): MnemonicDerived {
  const m = normalizeMnemonic(mnemonic)
  const seed = m.toSeed(passphrase)
  const digest = Hash.sha256(Array.from(seed))
  const rootKeyHex = digest.map((b) => b.toString(16).padStart(2, '0')).join('')
  const key = PrivateKey.fromHex(rootKeyHex)
  return derivedFromPrivateKey(key, m.toString(), 'brc-75')
}

/** Legacy Desktop path: BIP39 seed → BIP32 HD master private key. */
export function rootKeyFromMnemonicLegacyHd(mnemonic: string, passphrase = ''): MnemonicDerived {
  const m = normalizeMnemonic(mnemonic)
  const seed = m.toSeed(passphrase)
  const hd = HD.fromSeed(seed)
  return derivedFromPrivateKey(hd.privKey, m.toString(), 'legacy-hd')
}

/**
 * BIP39 seed → BIP32 child key at an explicit HD path.
 *
 * `m` returns the master key (same as {@link rootKeyFromMnemonicLegacyHd}).
 * Used to reach foreign wallets (Yours, RelayX, Twetch) that keep funds and
 * ordinals on distinct BIP44 branches rather than at the seed root.
 */
export function keyFromMnemonicHdPath(
  mnemonic: string,
  path: string,
  passphrase = '',
): MnemonicDerived {
  const m = normalizeMnemonic(mnemonic)
  const seed = m.toSeed(passphrase)
  const hd = HD.fromSeed(seed)
  const node = !path || path === 'm' ? hd : hd.derive(path)
  return derivedFromPrivateKey(node.privKey, m.toString(), 'legacy-hd')
}

/** Default derivation for new wallets / backups (BRC-75). */
export function rootKeyFromMnemonic(mnemonic: string, passphrase = ''): MnemonicDerived {
  return rootKeyFromMnemonicBrc75(mnemonic, passphrase)
}

/**
 * Pick BRC-75 unless local toolbox / vault already belongs to the legacy HD key.
 */
async function resolveMnemonicDerivation(
  mnemonic: string,
  passphrase: string,
): Promise<MnemonicDerived> {
  const brc75 = rootKeyFromMnemonicBrc75(mnemonic, passphrase)
  const legacy = rootKeyFromMnemonicLegacyHd(mnemonic, passphrase)
  if (brc75.identityKey === legacy.identityKey) return brc75

  const meta = readVaultMeta()
  if (meta?.identityKey === legacy.identityKey) return legacy
  if (meta?.identityKey === brc75.identityKey) return brc75

  const toolboxKeys = await listToolboxIdentityKeys()
  if (toolboxKeys.includes(legacy.identityKey) && !toolboxKeys.includes(brc75.identityKey)) {
    return legacy
  }
  return brc75
}

async function encryptSecret(
  password: string,
  secret: string,
): Promise<{ ciphertext: string; iv: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, salt)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(secret),
  )
  return { ciphertext: b64(ciphertext), iv: b64(iv), salt: b64(salt) }
}

async function decryptSecret(password: string, record: VaultRecord): Promise<string> {
  const key = await deriveKey(password, fromB64(record.salt))
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBufferSource(fromB64(record.iv)) },
    key,
    toBufferSource(fromB64(record.ciphertext)),
  )
  return new TextDecoder().decode(plain)
}

function parseUnlockedSecret(plain: string): { rootKeyHex: string; mnemonic: string | null } {
  const trimmed = plain.trim()
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as VaultSecretV2
    if (typeof parsed.rootKeyHex !== 'string') throw new Error('Corrupt wallet vault')
    PrivateKey.fromHex(parsed.rootKeyHex)
    return {
      rootKeyHex: parsed.rootKeyHex,
      mnemonic: typeof parsed.mnemonic === 'string' ? parsed.mnemonic : null,
    }
  }
  PrivateKey.fromHex(trimmed)
  return { rootKeyHex: trimmed, mnemonic: null }
}

export function hasVault(): boolean {
  return readVaultRaw() !== null
}

export function readVaultMeta(): Pick<
  VaultRecord,
  'handle' | 'identityKey' | 'address' | 'chain' | 'hasMnemonic' | 'version'
> | null {
  const raw = readVaultRaw()
  if (!raw) return null
  const parsed = JSON.parse(raw) as VaultRecord
  return {
    handle: parsed.handle,
    identityKey: parsed.identityKey,
    address: parsed.address,
    chain: parsed.chain,
    hasMnemonic: parsed.hasMnemonic,
    version: parsed.version,
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

const LOCAL_WALLET_LABEL = 'wallet'

export async function listToolboxIdentityKeys(): Promise<string[]> {
  if (typeof indexedDB === 'undefined') return []

  try {
    if (typeof indexedDB.databases === 'function') {
      const dbs = await indexedDB.databases()
      if (!dbs.some((d) => d.name === TOOLBOX_DB)) return []
    }
  } catch {
    // fall through
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
      try {
        req.transaction?.abort()
      } catch {
        // ignore
      }
      resolve([])
    }
    req.onsuccess = () => {
      const db = req.result
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

export async function hasOrphanedToolboxWallet(): Promise<boolean> {
  if (hasVault()) return false
  const keys = await listToolboxIdentityKeys()
  return keys.length > 0
}

export async function getVaultToolboxMismatch(
  vaultIdentityKey: string,
): Promise<ToolboxMismatch | null> {
  const toolboxIdentityKeys = await listToolboxIdentityKeys()
  if (toolboxIdentityKeys.length === 0) return null
  if (toolboxIdentityKeys.includes(vaultIdentityKey)) return null
  return {
    vaultIdentityKey,
    toolboxIdentityKeys,
    orphanedFundsLikely: true,
  }
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
      'This device already has wallet funds under another key. Creating a new wallet is blocked. Restore with your recovery phrase, BRC-140 shares, or emergency key if you have them.',
    )
  }
}

/**
 * Restore is allowed when there is no vault, or when toolbox orphans exist and
 * the mnemonic identity matches one of those toolbox users (recovery path).
 */
export async function assertSafeToRestoreVault(identityKey: string): Promise<void> {
  if (hasVault()) {
    const meta = readVaultMeta()
    if (meta?.identityKey === identityKey) {
      throw new Error('This wallet is already installed. Unlock it with your password.')
    }
    throw new Error(
      'A different wallet already exists on this device. Refusing to replace its keys.',
    )
  }
  const toolboxKeys = await listToolboxIdentityKeys()
  if (toolboxKeys.length > 0 && !toolboxKeys.includes(identityKey)) {
    throw new Error(
      'That recovery phrase does not match the wallet data on this device. Refusing to create a mismatched vault.',
    )
  }
}

export async function createVault(args: {
  password: string
  chain: Chain
  handle?: string
}): Promise<UnlockedVault> {
  await assertSafeToCreateVault()

  const handle = args.handle ? normalizeHandle(args.handle) : LOCAL_WALLET_LABEL
  const createPwError = validatePassword(args.password)
  if (createPwError) throw new Error(createPwError)

  // BRC-75 examples use 128-bit entropy → 12-word BIP39 phrase.
  const generated = Mnemonic.fromRandom(128)
  const mnemonic = generated.toString()
  const derived = rootKeyFromMnemonicBrc75(mnemonic)
  const secret: VaultSecretV2 = { rootKeyHex: derived.rootKeyHex, mnemonic }
  const enc = await encryptSecret(args.password, JSON.stringify(secret))

  const record: VaultRecord = {
    version: 2,
    chain: args.chain,
    handle,
    identityKey: derived.identityKey,
    address: derived.address,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    salt: enc.salt,
    hasMnemonic: true,
  }
  persistVault(record, 'create')
  return { rootKeyHex: derived.rootKeyHex, mnemonic, record }
}

export async function restoreVaultFromMnemonic(args: {
  mnemonic: string
  password: string
  chain: Chain
  handle?: string
  passphrase?: string
}): Promise<UnlockedVault> {
  const restorePwError = validatePassword(args.password)
  if (restorePwError) throw new Error(restorePwError)
  const derived = await resolveMnemonicDerivation(args.mnemonic, args.passphrase ?? '')

  let allowIdentityReplace = false
  if (hasVault()) {
    const meta = readVaultMeta()
    if (meta?.identityKey === derived.identityKey) {
      throw new Error('This wallet is already installed. Unlock it with your password.')
    }
    const mismatch = meta ? await getVaultToolboxMismatch(meta.identityKey) : null
    const toolboxKeys = await listToolboxIdentityKeys()
    if (mismatch?.orphanedFundsLikely && toolboxKeys.includes(derived.identityKey)) {
      // Wrong vault on disk, phrase matches funded toolbox identity — replace keys.
      allowIdentityReplace = true
    } else {
      throw new Error(
        'A different wallet already exists on this device. Refusing to replace its keys.',
      )
    }
  } else {
    await assertSafeToRestoreVault(derived.identityKey)
  }

  const handle = args.handle ? normalizeHandle(args.handle) : LOCAL_WALLET_LABEL
  const secret: VaultSecretV2 = { rootKeyHex: derived.rootKeyHex, mnemonic: derived.mnemonic }
  const enc = await encryptSecret(args.password, JSON.stringify(secret))

  const record: VaultRecord = {
    version: 2,
    chain: args.chain,
    handle,
    identityKey: derived.identityKey,
    address: derived.address,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    salt: enc.salt,
    hasMnemonic: true,
  }
  persistVault(record, 'restore', { allowIdentityReplace })
  return { rootKeyHex: derived.rootKeyHex, mnemonic: derived.mnemonic, record }
}

/**
 * Restore from a BRC-140 reconstructed root key (no mnemonic).
 * Same custody guards as mnemonic restore.
 */
export async function restoreVaultFromRootKey(args: {
  rootKeyHex: string
  password: string
  chain: Chain
  handle?: string
}): Promise<UnlockedVault> {
  const rootPwError = validatePassword(args.password)
  if (rootPwError) throw new Error(rootPwError)
  const key = PrivateKey.fromHex(args.rootKeyHex.trim())
  const rootKeyHex = key.toHex()
  const identityKey = key.toPublicKey().toString()
  const address = key.toAddress()

  let allowIdentityReplace = false
  if (hasVault()) {
    const meta = readVaultMeta()
    if (meta?.identityKey === identityKey) {
      throw new Error('This wallet is already installed. Unlock it with your password.')
    }
    const mismatch = meta ? await getVaultToolboxMismatch(meta.identityKey) : null
    const toolboxKeys = await listToolboxIdentityKeys()
    if (mismatch?.orphanedFundsLikely && toolboxKeys.includes(identityKey)) {
      allowIdentityReplace = true
    } else {
      throw new Error(
        'A different wallet already exists on this device. Refusing to replace its keys.',
      )
    }
  } else {
    await assertSafeToRestoreVault(identityKey)
  }

  const handle = args.handle ? normalizeHandle(args.handle) : LOCAL_WALLET_LABEL
  const enc = await encryptSecret(args.password, rootKeyHex)

  const record: VaultRecord = {
    version: 1,
    chain: args.chain,
    handle,
    identityKey,
    address,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    salt: enc.salt,
    hasMnemonic: false,
  }
  persistVault(record, 'restore', { allowIdentityReplace })
  return { rootKeyHex, mnemonic: null, record }
}

export async function unlockVault(password: string): Promise<UnlockedVault> {
  const raw = readVaultRaw()
  if (!raw) throw new Error('No wallet found')
  const record = JSON.parse(raw) as VaultRecord
  try {
    const plain = await decryptSecret(password, record)
    const { rootKeyHex, mnemonic } = parseUnlockedSecret(plain)
    const mismatch = await getVaultToolboxMismatch(record.identityKey)
    if (mismatch?.orphanedFundsLikely) {
      appendAudit({
        at: Date.now(),
        action: 'mismatch-warn',
        identityKeyPrefix: prefixIk(record.identityKey),
        previousIdentityKeyPrefix: prefixIk(mismatch.toolboxIdentityKeys[0]),
        detail: 'vault-toolbox-mismatch',
      })
      throw new Error(
        'This unlock key does not match the funded wallet data on this device. Do not create a new wallet. Restore with the original recovery phrase, BRC-140 shares, or emergency key if you have them.',
      )
    }
    return { rootKeyHex, mnemonic, record }
  } catch (err) {
    if (err instanceof Error && err.message.includes('does not match the funded')) throw err
    throw new Error('Incorrect password')
  }
}

/** Reveal mnemonic after password check (Settings backup). */
export async function revealMnemonic(password: string): Promise<string> {
  const unlocked = await unlockVault(password)
  if (!unlocked.mnemonic) {
    throw new Error(
      'This wallet was created before recovery phrases. Export an emergency key backup instead.',
    )
  }
  return unlocked.mnemonic
}

/** Emergency: reveal root key hex after password check (legacy wallets). */
export async function revealRootKeyHex(password: string): Promise<string> {
  const unlocked = await unlockVault(password)
  return unlocked.rootKeyHex
}

export async function changeVaultPassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const pwError = validatePassword(newPassword)
  if (pwError) throw new Error(pwError)
  if (currentPassword === newPassword) {
    throw new Error('New password must be different from your current password')
  }

  const unlocked = await unlockVault(currentPassword)
  const secret = unlocked.mnemonic
    ? JSON.stringify({ rootKeyHex: unlocked.rootKeyHex, mnemonic: unlocked.mnemonic } satisfies VaultSecretV2)
    : unlocked.rootKeyHex
  const enc = await encryptSecret(newPassword, secret)

  const updated: VaultRecord = {
    ...unlocked.record,
    version: unlocked.mnemonic ? 2 : unlocked.record.version,
    hasMnemonic: Boolean(unlocked.mnemonic),
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    salt: enc.salt,
  }
  persistVault(updated, 'password')
}
