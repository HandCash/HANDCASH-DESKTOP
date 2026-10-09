import { getWalletRuntime } from './walletRuntime'
/**
 * Vault custody: DEK-wrapped root key + BIP39 mnemonic, durable across origins.
 *
 * Unlock factors (independent wraps of the same DEK):
 * - In-app password (PBKDF2 → AES-GCM)
 * - Device lock (biometrics / phone PIN / Touch ID / Windows Hello via native seal)
 *
 * Legacy v1/v2 vaults encrypt the secret directly with the password; unlock migrates
 * them to v3 (DEK + password wrap). OS-sealed at rest when Electron safeStorage is
 * available (separate from the device unlock factor).
 *
 * Lifecycle: create-once | restore | unlock | rewrap factors.
 * Never mint a second root while toolbox UTXOs or an existing vault identity exist.
 * The vault secret is the master every account derives from (BRC-208). New
 * vaults hold BRC-157 entropy (24 words); older ones a root that is account 0.
 */
import { Hash, HD, Mnemonic, PrivateKey } from '@bsv/sdk'
import { base64ToBytes, bytesToBase64 } from './base64Binary'
import {
  deviceAuthClear,
  deviceAuthEnroll,
  deviceAuthStatus,
  deviceAuthUnlock,
} from './deviceAuth.js'
import { durableGetItem, durableSetItem } from './durableStorage.js'
import { initCreatedVaultAccounts } from './vaultAccounts'
import {
  accountRootKeyHex,
  brc157VaultMaster,
  brc157VaultMasterFromKey,
  brc42VaultMaster,
  parseVaultMaster,
  type AccountDerivation,
  type VaultMaster,
} from './vaultMaster'
import { validatePassword } from './passwordPolicy.js'

/** BRC-157 entropy (new vaults), BRC-75, or the pre-BRC-75 HD master of a BIP39 seed. */
export type MnemonicScheme = 'brc-157' | 'brc-75' | 'legacy-hd'

const VAULT_KEY = 'handcash.brc100.vault.v1'
const VAULT_BACKUP_KEY = 'handcash.brc100.vault.backup.v1'
const VAULT_AUDIT_KEY = 'handcash.brc100.vault.audit.v1'
const TOOLBOX_DB = 'wallet-toolbox-mainnet'

export type Chain = 'main' | 'test'

/** Password wrap of the vault DEK (v3). */
export type PasswordWrap = {
  salt: string
  iv: string
  ciphertext: string
}

export type VaultWraps = {
  password?: PasswordWrap
  /** DEK lives in native device seal — not in this JSON. */
  device?: { enrolled: true }
}

export type VaultRecord = {
  version: 1 | 2 | 3
  chain: Chain
  handle: string
  identityKey: string
  address: string
  /**
   * AES-GCM ciphertext of the vault secret.
   * v1/v2: encrypted directly with password-derived key.
   * v3: encrypted with a random DEK; wraps hold factor envelopes of that DEK.
   */
  ciphertext: string
  iv: string
  /** v1/v2 only — password salt for direct secret wrap. */
  salt?: string
  /** Present on v2+ wallets created/restored with BIP39. */
  hasMnemonic?: boolean
  /** How accounts derive from the vault secret; absent on older vaults (`brc-42`). */
  derivation?: AccountDerivation
  /** v3 multi-factor wraps of the DEK. */
  wraps?: VaultWraps
}

export type VaultUnlockFactors = {
  password: boolean
  device: boolean
}

export type UnlockedVault = {
  master: VaultMaster
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

/** `rootKeyHex` is the vault master's key; a BRC-157 entropy key when `derivation` says so. */
type VaultSecretV2 = {
  rootKeyHex: string
  mnemonic: string | null
  derivation?: 'brc-157'
  entropyLength?: number
}

function serializeVaultSecret(master: VaultMaster, mnemonic: string | null): string {
  if (master.derivation === 'brc-157') {
    return JSON.stringify({
      rootKeyHex: master.keyHex,
      mnemonic,
      derivation: 'brc-157',
      entropyLength: master.entropyLength,
    } satisfies VaultSecretV2)
  }
  return mnemonic
    ? JSON.stringify({ rootKeyHex: master.keyHex, mnemonic } satisfies VaultSecretV2)
    : master.keyHex
}

function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return bytesToBase64(u8)
}

function fromB64(s: string): Uint8Array {
  return base64ToBytes(s)
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
  master: VaultMaster
  /** Account 0's root key, identity and address. */
  rootKeyHex: string
  identityKey: string
  address: string
  mnemonic: string
  scheme: MnemonicScheme
  label: string
}

function normalizeMnemonic(mnemonic: string): Mnemonic {
  const m = Mnemonic.fromString(mnemonic.trim().toLowerCase().replace(/\s+/g, ' '))
  if (!m.check()) throw new Error('Invalid recovery phrase')
  return m
}

function derivedFromMaster(master: VaultMaster, mnemonic: string, scheme: MnemonicScheme): MnemonicDerived {
  const primary = PrivateKey.fromHex(accountRootKeyHex(master, 0))
  return {
    master,
    rootKeyHex: primary.toHex(),
    identityKey: primary.toPublicKey().toString(),
    address: primary.toAddress(),
    mnemonic,
    scheme,
    label: scheme,
  }
}

function derivedFromPrivateKey(
  key: PrivateKey,
  mnemonic: string,
  scheme: MnemonicScheme,
): MnemonicDerived {
  return derivedFromMaster(brc42VaultMaster(key.toHex()), mnemonic, scheme)
}

/**
 * BRC-157 — the phrase encodes entropy; accounts are BIP-32 profiles
 * `m/0'/n'` of its seed (empty passphrase). New wallets use 32 bytes (24 words).
 */
export function rootKeyFromMnemonicBrc157(mnemonic: string): MnemonicDerived {
  const m = normalizeMnemonic(mnemonic)
  return derivedFromMaster(brc157VaultMaster(m.toEntropy()), m.toString(), 'brc-157')
}

/** BRC-75 — BIP39 mnemonic → seed → SHA-256(seed) as the master private key. */
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

/**
 * Which reading of a phrase this device restores: a reading the local vault or
 * toolbox already holds, else the one with something to recover (see
 * `vaultMasterChoice.ts`). With nothing anywhere, 24 words without a
 * passphrase are BRC-157 (what HandCash creates); shorter phrases are BRC-75.
 */
async function resolveMnemonicDerivation(
  mnemonic: string,
  passphrase: string,
  chain: Chain,
): Promise<MnemonicDerived> {
  const brc75 = rootKeyFromMnemonicBrc75(mnemonic, passphrase)
  const legacy = rootKeyFromMnemonicLegacyHd(mnemonic, passphrase)
  const brc157 = passphrase ? null : rootKeyFromMnemonicBrc157(mnemonic)
  const candidates = [brc157, brc75, legacy].filter((c): c is MnemonicDerived => c !== null)

  const meta = readVaultMeta()
  const toolboxKeys = await listToolboxIdentityKeys()
  const local = candidates.find(
    (c) => meta?.identityKey === c.identityKey || toolboxKeys.includes(c.identityKey),
  )
  if (local) return local

  const preferred = brc157 && brc75.mnemonic.split(' ').length === 24 ? brc157 : brc75
  const { chooseRestoredMaster, probeVaultMasterUse } = await import('./vaultMasterChoice')
  return chooseRestoredMaster({ candidates, preferred, probe: probeVaultMasterUse(chain) })
}

/**
 * Which reading of a reconstructed key (emergency key or BRC-140 slices): a
 * BRC-157 entropy key or a BRC-42 root. Same evidence order as phrases; with
 * nothing anywhere it is BRC-157, the reading of every key HandCash issues now.
 */
async function resolveKeyDerivation(keyHex: string, chain: Chain): Promise<{ master: VaultMaster; label: string }> {
  const brc157 = { master: brc157VaultMasterFromKey(keyHex), label: 'brc-157' }
  const brc42 = { master: brc42VaultMaster(keyHex), label: 'brc-42' }
  const candidates = [brc157, brc42]
  const meta = readVaultMeta()
  const toolboxKeys = await listToolboxIdentityKeys()
  const local = candidates.find((c) => {
    const id = PrivateKey.fromHex(accountRootKeyHex(c.master, 0)).toPublicKey().toString()
    return meta?.identityKey === id || toolboxKeys.includes(id)
  })
  if (local) return local
  const { chooseRestoredMaster, probeVaultMasterUse } = await import('./vaultMasterChoice')
  return chooseRestoredMaster({ candidates, preferred: brc157, probe: probeVaultMasterUse(chain) })
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toBufferSource(raw), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

async function encryptWithKey(
  key: CryptoKey,
  plain: Uint8Array,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    toBufferSource(plain),
  )
  return { ciphertext: b64(ciphertext), iv: b64(iv) }
}

async function decryptWithKey(
  key: CryptoKey,
  ciphertextB64: string,
  ivB64: string,
): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBufferSource(fromB64(ivB64)) },
    key,
    toBufferSource(fromB64(ciphertextB64)),
  )
  return new Uint8Array(plain)
}

async function wrapDekWithPassword(
  password: string,
  dek: Uint8Array,
): Promise<PasswordWrap> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await deriveKey(password, salt)
  const enc = await encryptWithKey(key, dek)
  return { salt: b64(salt), iv: enc.iv, ciphertext: enc.ciphertext }
}

async function unwrapDekWithPassword(
  password: string,
  wrap: PasswordWrap,
): Promise<Uint8Array> {
  const key = await deriveKey(password, fromB64(wrap.salt))
  return decryptWithKey(key, wrap.ciphertext, wrap.iv)
}

/** Legacy v1/v2: password encrypts the secret string directly. */
async function decryptSecretLegacy(password: string, record: VaultRecord): Promise<string> {
  if (!record.salt) throw new Error('Corrupt wallet vault')
  const key = await deriveKey(password, fromB64(record.salt))
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBufferSource(fromB64(record.iv)) },
    key,
    toBufferSource(fromB64(record.ciphertext)),
  )
  return new TextDecoder().decode(plain)
}

async function encryptSecretWithDek(
  dek: Uint8Array,
  secret: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await importAesKey(dek)
  return encryptWithKey(key, new TextEncoder().encode(secret))
}

async function decryptSecretWithDek(
  dek: Uint8Array,
  ciphertextB64: string,
  ivB64: string,
): Promise<string> {
  const key = await importAesKey(dek)
  const plain = await decryptWithKey(key, ciphertextB64, ivB64)
  return new TextDecoder().decode(plain)
}

function newDek(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

function dekToB64(dek: Uint8Array): string {
  return b64(dek)
}

function dekFromB64(s: string): Uint8Array {
  const raw = fromB64(s)
  if (raw.length !== 32) throw new Error('Invalid device unlock material')
  return raw
}

export function readVaultUnlockFactors(): VaultUnlockFactors {
  const raw = readVaultRaw()
  if (!raw) return { password: false, device: false }
  try {
    const record = JSON.parse(raw) as VaultRecord
    if (record.version === 3 && record.wraps) {
      return {
        password: Boolean(record.wraps.password),
        device: Boolean(record.wraps.device?.enrolled),
      }
    }
    // Legacy vaults are always password-wrapped.
    return { password: true, device: false }
  } catch {
    return { password: false, device: false }
  }
}

function assertAtLeastOneFactor(wraps: VaultWraps): void {
  if (!wraps.password && !wraps.device?.enrolled) {
    throw new Error('Wallet must keep at least one unlock method')
  }
}

async function buildV3Record(args: {
  chain: Chain
  handle: string
  identityKey: string
  address: string
  secret: string
  hasMnemonic: boolean
  derivation: AccountDerivation
  password?: string
  useDevice?: boolean
}): Promise<VaultRecord> {
  const hasPassword = Boolean(args.password)
  const useDevice = Boolean(args.useDevice)
  if (!hasPassword && !useDevice) {
    throw new Error('Choose device unlock, a HandCash password, or both')
  }
  if (args.password) {
    const pwError = validatePassword(args.password)
    if (pwError) throw new Error(pwError)
  }

  const dek = newDek()
  const enc = await encryptSecretWithDek(dek, args.secret)
  const wraps: VaultWraps = {}
  if (args.password) {
    wraps.password = await wrapDekWithPassword(args.password, dek)
  }
  if (useDevice) {
    const status = await deviceAuthStatus()
    if (!status.available) {
      throw new Error('Device unlock is not available on this device')
    }
    const enrolled = await deviceAuthEnroll(dekToB64(dek))
    if (!enrolled.ok) throw new Error(enrolled.error)
    wraps.device = { enrolled: true }
  }
  assertAtLeastOneFactor(wraps)

  return {
    version: 3,
    chain: args.chain,
    handle: args.handle,
    identityKey: args.identityKey,
    address: args.address,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    hasMnemonic: args.hasMnemonic,
    ...(args.derivation === 'brc-157' ? { derivation: 'brc-157' as const } : {}),
    wraps,
  }
}

async function migrateLegacyToV3(
  password: string,
  record: VaultRecord,
  secretPlain: string,
): Promise<VaultRecord> {
  const dek = newDek()
  const enc = await encryptSecretWithDek(dek, secretPlain)
  const wraps: VaultWraps = {
    password: await wrapDekWithPassword(password, dek),
  }
  const migrated: VaultRecord = {
    version: 3,
    chain: record.chain,
    handle: record.handle,
    identityKey: record.identityKey,
    address: record.address,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    hasMnemonic: Boolean(record.hasMnemonic ?? secretPlain.trim().startsWith('{')),
    wraps,
  }
  persistVault(migrated, 'password')
  return migrated
}

async function unlockWithDek(
  dek: Uint8Array,
  record: VaultRecord,
): Promise<UnlockedVault> {
  if (record.version !== 3) throw new Error('Corrupt wallet vault')
  const plain = await decryptSecretWithDek(dek, record.ciphertext, record.iv)
  const { master, mnemonic } = parseUnlockedSecret(plain)
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
  return { master, mnemonic, record }
}

function parseUnlockedSecret(plain: string): { master: VaultMaster; mnemonic: string | null } {
  const trimmed = plain.trim()
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as VaultSecretV2
    if (typeof parsed.rootKeyHex !== 'string') throw new Error('Corrupt wallet vault')
    return {
      master: parseVaultMaster({
        keyHex: parsed.rootKeyHex,
        derivation: parsed.derivation,
        entropyLength: parsed.entropyLength,
      }),
      mnemonic: typeof parsed.mnemonic === 'string' ? parsed.mnemonic : null,
    }
  }
  return { master: brc42VaultMaster(trimmed), mnemonic: null }
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
      throw new Error('This wallet is already installed. Unlock it instead.')
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
  password?: string
  useDevice?: boolean
  chain: Chain
  handle?: string
}): Promise<UnlockedVault> {
  await assertSafeToCreateVault()

  const handle = args.handle ? normalizeHandle(args.handle) : LOCAL_WALLET_LABEL

  // BRC-157: 32 bytes of entropy in [1, n−1] (a random key), 24 words.
  const entropy = PrivateKey.fromRandom().toArray('be', 32)
  const mnemonic = Mnemonic.fromEntropy(entropy).toString()
  const derived = rootKeyFromMnemonicBrc157(mnemonic)
  const record = await buildV3Record({
    chain: args.chain,
    handle,
    identityKey: derived.identityKey,
    address: derived.address,
    secret: serializeVaultSecret(derived.master, mnemonic),
    hasMnemonic: true,
    derivation: derived.master.derivation,
    password: args.password,
    useDevice: args.useDevice,
  })
  persistVault(record, 'create')
  initCreatedVaultAccounts(derived.master)
  return { master: derived.master, mnemonic, record }
}

export async function restoreVaultFromMnemonic(args: {
  mnemonic: string
  password?: string
  useDevice?: boolean
  chain: Chain
  handle?: string
  passphrase?: string
}): Promise<UnlockedVault> {
  const derived = await resolveMnemonicDerivation(args.mnemonic, args.passphrase ?? '', args.chain)

  let allowIdentityReplace = false
  if (hasVault()) {
    const meta = readVaultMeta()
    if (meta?.identityKey === derived.identityKey) {
      throw new Error('This wallet is already installed. Unlock it instead.')
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
  const record = await buildV3Record({
    chain: args.chain,
    handle,
    identityKey: derived.identityKey,
    address: derived.address,
    secret: serializeVaultSecret(derived.master, derived.mnemonic),
    hasMnemonic: true,
    derivation: derived.master.derivation,
    password: args.password,
    useDevice: args.useDevice,
  })
  persistVault(record, 'restore', { allowIdentityReplace })
  return { master: derived.master, mnemonic: derived.mnemonic, record }
}

/**
 * Restore from an emergency key or BRC-140 reconstructed key (no mnemonic).
 * Same custody guards as mnemonic restore.
 */
export async function restoreVaultFromRootKey(args: {
  rootKeyHex: string
  password?: string
  useDevice?: boolean
  chain: Chain
  handle?: string
}): Promise<UnlockedVault> {
  const { master } = await resolveKeyDerivation(args.rootKeyHex, args.chain)
  const primary = PrivateKey.fromHex(accountRootKeyHex(master, 0))
  const identityKey = primary.toPublicKey().toString()
  const address = primary.toAddress()

  let allowIdentityReplace = false
  if (hasVault()) {
    const meta = readVaultMeta()
    if (meta?.identityKey === identityKey) {
      throw new Error('This wallet is already installed. Unlock it instead.')
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
  const record = await buildV3Record({
    chain: args.chain,
    handle,
    identityKey,
    address,
    secret: serializeVaultSecret(master, null),
    hasMnemonic: false,
    derivation: master.derivation,
    password: args.password,
    useDevice: args.useDevice,
  })
  persistVault(record, 'restore', { allowIdentityReplace })
  return { master, mnemonic: null, record }
}

export async function unlockVault(password: string): Promise<UnlockedVault> {
  const raw = readVaultRaw()
  if (!raw) throw new Error('No wallet found')
  const record = JSON.parse(raw) as VaultRecord
  try {
    if (record.version === 3) {
      const wrap = record.wraps?.password
      if (!wrap) throw new Error('This wallet has no HandCash password. Unlock with this device instead.')
      const dek = await unwrapDekWithPassword(password, wrap)
      return unlockWithDek(dek, record)
    }

    const plain = await decryptSecretLegacy(password, record)
    const migrated = await migrateLegacyToV3(password, record, plain)
    const { master, mnemonic } = parseUnlockedSecret(plain)
    const mismatch = await getVaultToolboxMismatch(migrated.identityKey)
    if (mismatch?.orphanedFundsLikely) {
      appendAudit({
        at: Date.now(),
        action: 'mismatch-warn',
        identityKeyPrefix: prefixIk(migrated.identityKey),
        previousIdentityKeyPrefix: prefixIk(mismatch.toolboxIdentityKeys[0]),
        detail: 'vault-toolbox-mismatch',
      })
      throw new Error(
        'This unlock key does not match the funded wallet data on this device. Do not create a new wallet. Restore with the original recovery phrase, BRC-140 shares, or emergency key if you have them.',
      )
    }
    return { master, mnemonic, record: migrated }
  } catch (err) {
    if (err instanceof Error && err.message.includes('does not match the funded')) throw err
    if (err instanceof Error && err.message.includes('no HandCash password')) throw err
    throw new Error('Incorrect password')
  }
}

/** Unlock via native device factor (fingerprint / PIN / Touch ID / Hello). */
export async function unlockVaultWithDevice(
  reason = 'Unlock HandCash',
): Promise<UnlockedVault> {
  const raw = readVaultRaw()
  if (!raw) throw new Error('No wallet found')
  const record = JSON.parse(raw) as VaultRecord
  if (record.version !== 3 || !record.wraps?.device?.enrolled) {
    throw new Error('Device unlock is not enabled for this wallet')
  }
  const unlocked = await deviceAuthUnlock(reason)
  if (!unlocked.ok) {
    if (unlocked.error === 'cancelled') throw new Error('cancelled')
    throw new Error(unlocked.error || 'Device unlock failed')
  }
  try {
    const dek = dekFromB64(unlocked.secret)
    return await unlockWithDek(dek, record)
  } catch (err) {
    if (err instanceof Error && err.message.includes('does not match the funded')) throw err
    throw new Error('Device unlock failed')
  }
}

/** Reveal mnemonic from the unlocked session — never gated on HandCash password. */
export async function revealMnemonic(_password?: string | null): Promise<string> {
  const active = getWalletRuntime()?.instance ?? null
  if (active?.mnemonic) return active.mnemonic
  // Locked: device factor only (not the in-app password).
  const unlocked = await unlockVaultWithDevice('Reveal recovery phrase')
  if (!unlocked.mnemonic) {
    throw new Error(
      'This wallet was created before recovery phrases. Export an emergency key backup instead.',
    )
  }
  return unlocked.mnemonic
}

/**
 * Reveal the vault master's key from the unlocked session — never gated on
 * HandCash password. Always the master (BRC-157 entropy key or BRC-42 root):
 * sub-accounts (BRC-208) derive from it, so a backup of an account's own key
 * would restore that account as a new, unrelated vault and strand the rest.
 */
export async function revealRootKeyHex(_password?: string | null): Promise<string> {
  const active = getWalletRuntime()?.instance ?? null
  if (active) return active.vaultMaster.keyHex
  const unlocked = await unlockVaultWithDevice('Reveal emergency key')
  return unlocked.master.keyHex
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
  const secret = serializeVaultSecret(unlocked.master, unlocked.mnemonic)

  // Prefer re-wrapping the existing DEK when already on v3.
  let dek: Uint8Array
  let ciphertext = unlocked.record.ciphertext
  let iv = unlocked.record.iv
  if (unlocked.record.version === 3 && unlocked.record.wraps?.password) {
    dek = await unwrapDekWithPassword(currentPassword, unlocked.record.wraps.password)
  } else {
    dek = newDek()
    const enc = await encryptSecretWithDek(dek, secret)
    ciphertext = enc.ciphertext
    iv = enc.iv
  }

  const wraps: VaultWraps = {
    ...(unlocked.record.wraps ?? {}),
    password: await wrapDekWithPassword(newPassword, dek),
  }
  if (wraps.device?.enrolled) {
    const reenroll = await deviceAuthEnroll(dekToB64(dek))
    if (!reenroll.ok) {
      // Keep previous device enrollment if re-seal fails — password wrap still updates.
      console.warn('[vault] device re-enroll after password change failed', reenroll.error)
    }
  }

  const updated: VaultRecord = {
    ...unlocked.record,
    version: 3,
    hasMnemonic: Boolean(unlocked.mnemonic),
    ciphertext,
    iv,
    salt: undefined,
    wraps,
  }
  persistVault(updated, 'password')
}

/**
 * Add or replace the HandCash password wrap after verifying device unlock.
 * Used when enabling password from a device-only wallet.
 */
export async function setVaultPasswordFromDevice(
  newPassword: string,
  reason = 'Confirm to set a HandCash password',
): Promise<void> {
  const pwError = validatePassword(newPassword)
  if (pwError) throw new Error(pwError)
  const raw = readVaultRaw()
  if (!raw) throw new Error('No wallet found')
  const record = JSON.parse(raw) as VaultRecord
  if (record.version !== 3 || !record.wraps?.device?.enrolled) {
    throw new Error('Device unlock is required to set a password this way')
  }
  const native = await deviceAuthUnlock(reason)
  if (!native.ok) {
    if (native.error === 'cancelled') throw new Error('cancelled')
    throw new Error(native.error || 'Device unlock failed')
  }
  const dek = dekFromB64(native.secret)
  await unlockWithDek(dek, record)

  const wraps: VaultWraps = {
    ...record.wraps,
    password: await wrapDekWithPassword(newPassword, dek),
    device: { enrolled: true },
  }
  persistVault({ ...record, version: 3, salt: undefined, wraps }, 'password')
}

/** Enable device unlock using the current password to recover the DEK. */
export async function enableDeviceUnlock(password: string): Promise<void> {
  const unlocked = await unlockVault(password)
  let dek: Uint8Array
  let record = unlocked.record
  if (record.version === 3 && record.wraps?.password) {
    dek = await unwrapDekWithPassword(password, record.wraps.password)
  } else {
    // Should already be migrated by unlockVault — belt and suspenders.
    const secret = serializeVaultSecret(unlocked.master, unlocked.mnemonic)
    record = await migrateLegacyToV3(password, record, secret)
    dek = await unwrapDekWithPassword(password, record.wraps!.password!)
  }

  const status = await deviceAuthStatus()
  if (!status.available) throw new Error('Device unlock is not available on this device')
  const enrolled = await deviceAuthEnroll(dekToB64(dek))
  if (!enrolled.ok) throw new Error(enrolled.error)

  const wraps: VaultWraps = {
    ...(record.wraps ?? {}),
    password: record.wraps?.password,
    device: { enrolled: true },
  }
  assertAtLeastOneFactor(wraps)
  persistVault({ ...record, version: 3, salt: undefined, wraps }, 'password')
}

/** Turn off device unlock. Requires a password wrap to remain. */
export async function disableDeviceUnlock(password?: string): Promise<void> {
  const factors = readVaultUnlockFactors()
  if (!factors.device) return
  if (!factors.password) {
    throw new Error('Add a HandCash password before turning off device unlock')
  }
  if (password) {
    await unlockVault(password)
  }
  await deviceAuthClear()
  const raw = readVaultRaw()
  if (!raw) throw new Error('No wallet found')
  const record = JSON.parse(raw) as VaultRecord
  const wraps: VaultWraps = { ...(record.wraps ?? {}) }
  delete wraps.device
  assertAtLeastOneFactor(wraps)
  persistVault({ ...record, version: 3, wraps }, 'password')
}

/** Remove the HandCash password wrap. Requires device unlock enrolled + keys backup. */
export async function disableVaultPassword(password: string): Promise<void> {
  const { isKeysBackupConfirmed } = await import('./backupStatus.js')
  if (!isKeysBackupConfirmed()) {
    throw new Error('Save your recovery phrase or key slices before removing the HandCash password')
  }
  const factors = readVaultUnlockFactors()
  if (!factors.password) return
  if (!factors.device) {
    throw new Error('Turn on device unlock before removing your HandCash password')
  }
  const unlocked = await unlockVault(password)
  if (unlocked.record.version !== 3 || !unlocked.record.wraps?.password) {
    throw new Error('Password wrap missing')
  }
  // Ensure device seal still holds this DEK.
  const dek = await unwrapDekWithPassword(password, unlocked.record.wraps.password)
  const reenroll = await deviceAuthEnroll(dekToB64(dek))
  if (!reenroll.ok) throw new Error(reenroll.error)

  const wraps: VaultWraps = {
    device: { enrolled: true },
  }
  assertAtLeastOneFactor(wraps)
  persistVault(
    {
      ...unlocked.record,
      version: 3,
      salt: undefined,
      wraps,
    },
    'password',
  )
}
