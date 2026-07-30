import { PrivateKey } from '@bsv/sdk'

const VAULT_KEY = 'handcash.brc100.vault.v1'

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

export function hasVault(): boolean {
  return localStorage.getItem(VAULT_KEY) !== null
}

export function readVaultMeta(): Pick<VaultRecord, 'handle' | 'identityKey' | 'address' | 'chain'> | null {
  const raw = localStorage.getItem(VAULT_KEY)
  if (!raw) return null
  const parsed = JSON.parse(raw) as VaultRecord
  return {
    handle: parsed.handle,
    identityKey: parsed.identityKey,
    address: parsed.address,
    chain: parsed.chain,
  }
}

export function normalizeHandle(input: string): string {
  const cleaned = input.trim().replace(/^\$/, '').toLowerCase().replace(/[^a-z0-9_]/g, '')
  if (cleaned.length < 3) throw new Error('Handle must be at least 3 characters')
  return cleaned
}

/** Local vault label only — not a HandCash $handle. */
const LOCAL_WALLET_LABEL = 'wallet'

export async function createVault(args: {
  password: string
  chain: Chain
  /** @deprecated local DB label only; unused by UI */
  handle?: string
}): Promise<{ rootKeyHex: string; record: VaultRecord }> {
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
  localStorage.setItem(VAULT_KEY, JSON.stringify(record))
  return { rootKeyHex, record }
}

export async function unlockVault(password: string): Promise<{ rootKeyHex: string; record: VaultRecord }> {
  const raw = localStorage.getItem(VAULT_KEY)
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
    // Validate key parses
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
  localStorage.setItem(VAULT_KEY, JSON.stringify(updated))
}
