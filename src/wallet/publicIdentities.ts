import { EncryptedMessage, PrivateKey, Utils } from '@bsv/sdk'
import { storageRegistry } from '../storage/registry'
import { accountLocalKeyFor } from './accountLocalKeys'
import { durableGetItem, durableSetItem } from './durableStorage'
import type { ActiveWallet } from './session'
import { runtimeIsCurrent, type WalletRuntime } from './walletRuntime'
import {
  normalizePublicIdentityKey,
  signPublicIdentityProfile,
  verifyPublicIdentityProfile,
  type PublicIdentityFields,
  type PublicIdentityProfile,
} from './publicIdentityProfile'

export type ManagedPublicIdentity = {
  profile: PublicIdentityProfile
  signer: 'wallet' | 'imported' | 'public'
  /** BRC-78 ciphertext sealed to this wallet account. Never public export. */
  sealedKey?: string
}
type Store = {
  version: 1
  owner: string
  chain: 'main' | 'test'
  selected: string
  identities: ManagedPublicIdentity[]
}
const MAX_RECORDS = 32
export const MAX_IDENTITY_FILE_BYTES = 128 * 1024
const listeners = new Set<() => void>()
let generation = 0
export function subscribePublicIdentities(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function publicIdentitiesGeneration(): number {
  return generation
}
function announce() {
  generation++
  for (const listener of listeners) listener()
}
function activeOrThrow(runtime: WalletRuntime | null): ActiveWallet {
  if (!runtime)
    throw new Error('Unlock the wallet to manage public identities.')
  if (!runtimeIsCurrent(runtime))
    throw new Error('Wallet changed; retry on the selected account.')
  return runtime.instance
}
function keyFor(active: ActiveWallet): string {
  return accountLocalKeyFor(storageRegistry.publicIdentities.key, {
    identityKey: active.identityKey,
    accountIndex: active.accountIndex ?? 0,
    chain: active.chain,
  })
}
function empty(active: ActiveWallet): Store {
  return {
    version: 1,
    owner: active.identityKey.toLowerCase(),
    chain: active.chain,
    selected: active.identityKey.toLowerCase(),
    identities: [],
  }
}
function validateStore(raw: unknown, active: ActiveWallet): Store {
  const store = raw as Store
  if (
    !store ||
    store.version !== 1 ||
    store.owner !== active.identityKey.toLowerCase() ||
    store.chain !== active.chain ||
    !Array.isArray(store.identities) ||
    store.identities.length > MAX_RECORDS ||
    !normalizePublicIdentityKey(store.selected)
  )
    throw new Error('Invalid public identity backup.')
  const keys = new Set<string>()
  const identities = store.identities.map((row) => {
    const profile = verifyPublicIdentityProfile(
      row?.profile,
      undefined,
      active.chain,
    )
    if (
      !profile ||
      keys.has(profile.identityKey) ||
      !['wallet', 'imported', 'public'].includes(row.signer)
    )
      throw new Error('Invalid public identity record.')
    keys.add(profile.identityKey)
    if (row.signer === 'wallet' && profile.identityKey !== store.owner)
      throw new Error('Wallet identity does not match.')
    if (row.signer === 'imported') {
      if (typeof row.sealedKey !== 'string' || row.sealedKey.length > 4096)
        throw new Error('Imported signer is missing.')
    } else if (row.sealedKey !== undefined)
      throw new Error('Unexpected signing material.')
    return {
      profile,
      signer: row.signer,
      ...(row.sealedKey ? { sealedKey: row.sealedKey } : {}),
    }
  })
  if (
    store.selected !== store.owner &&
    !identities.some(
      (row) =>
        row.profile.identityKey === store.selected && row.signer !== 'public',
    )
  )
    throw new Error('Selected issuer is not controlled by this wallet.')
  return {
    version: 1,
    owner: store.owner,
    chain: store.chain,
    selected: store.selected,
    identities,
  }
}
let cached: { owner: string; raw: string; store: Store } | undefined
function read(active: ActiveWallet): Store {
  const raw = durableGetItem(keyFor(active))
  if (!raw) return empty(active)
  if (raw.length > MAX_IDENTITY_FILE_BYTES)
    throw new Error('Public identity store is too large.')
  if (cached?.owner === keyFor(active) && cached.raw === raw)
    return structuredClone(cached.store)
  const store = validateStore(JSON.parse(raw), active)
  cached = { owner: keyFor(active), raw, store }
  return structuredClone(store)
}
function write(runtime: WalletRuntime, store: Store) {
  const active = activeOrThrow(runtime)
  const validated = validateStore(store, active)
  const value = JSON.stringify(validated)
  if (value.length > MAX_IDENTITY_FILE_BYTES)
    throw new Error('Public identity store is too large.')
  if (!durableSetItem(keyFor(active), value))
    throw new Error(
      'Could not save public identities. No changes were committed.',
    )
  cached = undefined
  announce()
}
function decryptKey(active: ActiveWallet, row: ManagedPublicIdentity): string {
  if (!row.sealedKey) throw new Error('Imported signer is missing.')
  const plain = Utils.toUTF8(
    EncryptedMessage.decrypt(
      Utils.toArray(row.sealedKey, 'base64'),
      PrivateKey.fromHex(active.rootKeyHex),
    ),
  )
  const record = JSON.parse(plain)
  if (
    record.kind !== 'issuer-signing-key' ||
    record.owner !== active.identityKey.toLowerCase()
  )
    throw new Error('Imported key belongs to another wallet.')
  const key = parsePrivateKey(record.privateKey)
  if (key.toPublicKey().toString().toLowerCase() !== row.profile.identityKey)
    throw new Error('Imported key does not match the public profile.')
  return key.toHex().padStart(64, '0')
}
function parsePrivateKey(value: unknown): PrivateKey {
  if (typeof value !== 'string')
    throw new Error('Add a hex or WIF private signing key.')
  const text = value.trim()
  let hex: string
  if (/^[0-9a-f]{64}$/i.test(text)) hex = text
  else {
    const decoded = Utils.fromBase58Check(text, undefined) as {
      prefix: number[]
      data: number[]
    }
    if (
      ![0x80, 0xef].includes(decoded.prefix[0]!) ||
      decoded.prefix.length !== 1 ||
      ![32, 33].includes(decoded.data.length) ||
      (decoded.data.length === 33 && decoded.data[32] !== 1)
    )
      throw new Error('Invalid WIF signing key.')
    hex = Utils.toHex(decoded.data.slice(0, 32))
  }
  // Validate BEFORE SDK construction: PrivateKey's default constructor reduces
  // invalid scalars modulo n, which would silently import a different key.
  const scalar = BigInt('0x' + hex)
  if (
    scalar <= 0n ||
    scalar >=
      BigInt(
        '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
      )
  )
    throw new Error('Invalid private signing key.')
  const key = PrivateKey.fromHex(hex)
  key.toPublicKey()
  return key
}
function replace(
  runtime: WalletRuntime,
  store: Store,
  row: ManagedPublicIdentity,
) {
  const existing = store.identities.findIndex(
    (entry) => entry.profile.identityKey === row.profile.identityKey,
  )
  if (existing >= 0) store.identities[existing] = row
  else {
    if (store.identities.length >= MAX_RECORDS)
      throw new Error('At most 32 public identities are supported.')
    store.identities.push(row)
  }
  write(runtime, store)
}
export function listPublicIdentities(
  runtime: WalletRuntime | null,
): Omit<ManagedPublicIdentity, 'sealedKey'>[] {
  return read(activeOrThrow(runtime)).identities.map(({ profile, signer }) => ({
    profile,
    signer,
  }))
}
export function selectedPublicIdentityKey(
  runtime: WalletRuntime | null,
): string {
  const active = activeOrThrow(runtime)
  return read(active).selected
}
export function saveWalletPublicIdentity(
  runtime: WalletRuntime,
  fields: PublicIdentityFields,
) {
  const active = activeOrThrow(runtime)
  replace(runtime, read(active), {
    profile: signPublicIdentityProfile(active.rootKeyHex, active.chain, fields),
    signer: 'wallet',
  })
}
export function importIssuerPrivateKey(
  runtime: WalletRuntime,
  value: string,
  fields: PublicIdentityFields,
): string {
  const active = activeOrThrow(runtime)
  const key = parsePrivateKey(value)
  const profile = signPublicIdentityProfile(key.toHex(), active.chain, fields)
  if (profile.identityKey === active.identityKey.toLowerCase()) {
    saveWalletPublicIdentity(runtime, fields)
    return profile.identityKey
  }
  const root = PrivateKey.fromHex(active.rootKeyHex)
  const sealed = EncryptedMessage.encrypt(
    Utils.toArray(
      JSON.stringify({
        kind: 'issuer-signing-key',
        owner: active.identityKey.toLowerCase(),
        privateKey: key.toHex().padStart(64, '0'),
      }),
      'utf8',
    ),
    root,
    root.toPublicKey(),
  )
  replace(runtime, read(active), {
    profile,
    signer: 'imported',
    sealedKey: Utils.toBase64(sealed),
  })
  return profile.identityKey
}
export function updatePublicIdentity(
  runtime: WalletRuntime,
  identityKey: string,
  fields: PublicIdentityFields,
) {
  const active = activeOrThrow(runtime)
  const store = read(active)
  const row = store.identities.find(
    (entry) => entry.profile.identityKey === identityKey,
  )
  if (!row || row.signer === 'public')
    throw new Error('This wallet does not control that identity.')
  const root =
    row.signer === 'wallet' ? active.rootKeyHex : decryptKey(active, row)
  replace(runtime, store, {
    ...row,
    profile: signPublicIdentityProfile(root, active.chain, fields),
  })
}
export function selectPublicIdentity(
  runtime: WalletRuntime,
  identityKey: string,
) {
  const active = activeOrThrow(runtime)
  const store = read(active)
  if (
    identityKey !== active.identityKey.toLowerCase() &&
    !store.identities.some(
      (row) =>
        row.profile.identityKey === identityKey && row.signer !== 'public',
    )
  )
    throw new Error('This wallet does not control that issuer.')
  write(runtime, { ...store, selected: identityKey })
}
export function removePublicIdentity(
  runtime: WalletRuntime,
  identityKey: string,
) {
  const active = activeOrThrow(runtime)
  const store = read(active)
  write(runtime, {
    ...store,
    selected: store.selected === identityKey ? store.owner : store.selected,
    identities: store.identities.filter(
      (row) => row.profile.identityKey !== identityKey,
    ),
  })
}
export function importPublicIdentityProfile(
  runtime: WalletRuntime,
  raw: unknown,
) {
  const active = activeOrThrow(runtime)
  const store = read(active)
  const profile = verifyPublicIdentityProfile(raw, undefined, active.chain)
  if (!profile)
    throw new Error('Profile signature, fields, or network did not verify.')
  const existing = store.identities.find(
    (row) => row.profile.identityKey === profile.identityKey,
  )
  if (existing && profile.updatedAt < existing.profile.updatedAt)
    throw new Error('This profile is older than the saved version.')
  replace(runtime, store, {
    ...existing,
    profile,
    signer:
      existing?.signer ??
      (profile.identityKey === store.owner ? 'wallet' : 'public'),
  })
}
export function exportPublicIdentityBackup(runtime: WalletRuntime): string {
  return JSON.stringify(
    {
      kind: 'handcash-public-identities-backup',
      ...read(activeOrThrow(runtime)),
    },
    null,
    2,
  )
}
export function restorePublicIdentityBackup(
  runtime: WalletRuntime,
  raw: unknown,
) {
  const active = activeOrThrow(runtime)
  if ((raw as { kind?: unknown })?.kind !== 'handcash-public-identities-backup')
    throw new Error('Not a public identity backup.')
  const restored = validateStore(raw, active)
  const existing = read(active)
  // Keep identities absent from this backup; never delete a newly imported key.
  const byKey = new Map(
    existing.identities.map((row) => [row.profile.identityKey, row]),
  )
  for (const row of restored.identities) {
    const prior = byKey.get(row.profile.identityKey)
    const profile =
      prior && prior.profile.updatedAt >= row.profile.updatedAt
        ? prior.profile
        : row.profile
    const custody =
      prior?.signer === 'imported'
        ? prior
        : row.signer === 'imported'
          ? row
          : (prior ?? row)
    if (row.signer === 'imported') decryptKey(active, row)
    byKey.set(row.profile.identityKey, { ...custody, profile })
  }
  write(runtime, { ...existing, identities: [...byKey.values()] })
}
export function publicProfileForIssuer(
  runtime: WalletRuntime | null,
  identityKey: string,
): PublicIdentityProfile | null {
  if (!runtime || !runtimeIsCurrent(runtime)) return null
  const active = runtime.instance
  try {
    return (
      read(active).identities.find(
        (row) =>
          row.profile.identityKey === normalizePublicIdentityKey(identityKey),
      )?.profile ?? null
    )
  } catch {
    return null
  }
}
export function issuanceSigner(
  runtime: WalletRuntime,
  expectedKey?: string,
): {
  identityKey: string
  rootKeyHex: string
  profile?: PublicIdentityProfile
} {
  const active = activeOrThrow(runtime)
  const store = read(active)
  if (expectedKey && expectedKey !== store.selected)
    throw new Error('Issuer identity changed after approval; approve again.')
  const row = store.identities.find(
    (entry) => entry.profile.identityKey === store.selected,
  )
  const rootKeyHex =
    store.selected === store.owner
      ? active.rootKeyHex
      : row?.signer === 'imported'
        ? decryptKey(active, row)
        : null
  if (!rootKeyHex)
    throw new Error('Selected issuer signing key is unavailable.')
  return {
    identityKey: store.selected,
    rootKeyHex,
    ...(row ? { profile: row.profile } : {}),
  }
}
