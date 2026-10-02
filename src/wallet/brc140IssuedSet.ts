/**
 * The BRC-140 slice set this wallet handed out.
 *
 * BRC-140 splits are random, so splitting again on every reveal produced a
 * new set whose slices could not combine with the ones already saved — yet
 * carried the same integrity tag. The issued set is kept and shown again
 * until the holder rotates it.
 *
 * Sealed with AES-GCM under HKDF(root key): reading it requires the key the
 * slices reconstruct, so the record adds nothing an attacker can use.
 */
import { PrivateKey } from '@bsv/sdk'
import { storageRegistry } from '../storage/registry'
import { base64ToBytes, bytesToBase64 } from './base64Binary'
import { durableGetItem, durableSetItem } from './durableStorage'
import {
  BRC140_DEFAULT_THRESHOLD,
  BRC140_DEFAULT_TOTAL,
  createBrc140Shares,
  extendBrc140Shares,
  type Brc140ShareSet,
} from './brc140Backup'

const KEY = storageRegistry.brc140IssuedSet.key
const HKDF_INFO = 'handcash brc140 issued set v1'

export type Brc140IssuedSet = Brc140ShareSet & {
  issuedAt: number
  /** `restored` = re-issued on the split the holder recovered from. */
  origin: 'issued' | 'restored'
}

/**
 * Human label for a set. The integrity tag names the wallet, not the set, so
 * this is what lets a holder tell two sets of one wallet apart.
 */
export function sliceSetLabel(issuedAt: number): string {
  return `Set issued ${new Date(issuedAt).toISOString().slice(0, 10)}`
}

type SealedRecord = {
  v: 1
  identityKey: string
  issuedAt: number
  origin: Brc140IssuedSet['origin']
  iv: string
  ciphertext: string
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function sealKey(key: PrivateKey, identityKey: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    bufferOf(Uint8Array.from(key.toArray('be', 32))),
    'HKDF',
    false,
    ['deriveKey'],
  )
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

function isValidSetFor(key: PrivateKey, set: Brc140ShareSet): boolean {
  if (!Array.isArray(set.shares) || set.shares.length < set.threshold) return false
  try {
    for (let i = 0; i < set.shares.length; i++) {
      const pair = [set.shares[i]!, set.shares[(i + 1) % set.shares.length]!]
      if (PrivateKey.fromBackupShares(pair).toHex() !== key.toHex()) return false
    }
    return true
  } catch {
    return false
  }
}

async function persist(key: PrivateKey, set: Brc140IssuedSet): Promise<void> {
  const identityKey = key.toPublicKey().toString()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plain = new TextEncoder().encode(
    JSON.stringify({
      threshold: set.threshold,
      totalShares: set.totalShares,
      shares: set.shares,
      integrity: set.integrity,
    }),
  )
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bufferOf(iv) },
    await sealKey(key, identityKey),
    bufferOf(plain),
  )
  const record: SealedRecord = {
    v: 1,
    identityKey,
    issuedAt: set.issuedAt,
    origin: set.origin,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  }
  if (!durableSetItem(KEY, JSON.stringify(record))) {
    throw new Error('Could not save the key slice set on this device')
  }
}

/** The stored set for this root key, or null when absent / foreign / unreadable. */
export async function readBrc140IssuedSet(rootKeyHex: string): Promise<Brc140IssuedSet | null> {
  const raw = durableGetItem(KEY)
  if (!raw) return null
  const key = PrivateKey.fromHex(rootKeyHex.trim())
  const identityKey = key.toPublicKey().toString()
  try {
    const record = JSON.parse(raw) as SealedRecord
    if (record.v !== 1 || record.identityKey !== identityKey) return null
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bufferOf(base64ToBytes(record.iv)) },
      await sealKey(key, identityKey),
      bufferOf(base64ToBytes(record.ciphertext)),
    )
    const set = JSON.parse(new TextDecoder().decode(plain)) as Brc140ShareSet
    if (!isValidSetFor(key, set)) return null
    return { ...set, issuedAt: record.issuedAt, origin: record.origin }
  } catch {
    return null
  }
}

/** The set already handed out, or a first set when this wallet has none. */
export async function loadOrIssueBrc140Set(rootKeyHex: string): Promise<Brc140IssuedSet> {
  const existing = await readBrc140IssuedSet(rootKeyHex)
  if (existing) return existing
  return rotateBrc140Set(rootKeyHex)
}

/** Replace the issued set. Slices from the previous set stop combining with these. */
export async function rotateBrc140Set(rootKeyHex: string): Promise<Brc140IssuedSet> {
  const key = PrivateKey.fromHex(rootKeyHex.trim())
  const set: Brc140IssuedSet = {
    ...createBrc140Shares(rootKeyHex, BRC140_DEFAULT_THRESHOLD, BRC140_DEFAULT_TOTAL),
    issuedAt: Date.now(),
    origin: 'issued',
  }
  await persist(key, set)
  return set
}

/** After a slice restore: keep the holder's split as the issued set. */
export async function adoptRecoveredBrc140Set(
  rootKeyHex: string,
  sharesUsed: string[],
): Promise<Brc140IssuedSet> {
  const key = PrivateKey.fromHex(rootKeyHex.trim())
  const set: Brc140IssuedSet = {
    ...extendBrc140Shares(rootKeyHex, sharesUsed, BRC140_DEFAULT_TOTAL),
    issuedAt: Date.now(),
    origin: 'restored',
  }
  await persist(key, set)
  return set
}
