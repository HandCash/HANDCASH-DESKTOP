import { EncryptedMessage, PrivateKey, Utils } from '@bsv/sdk'
import { storageRegistry } from '../storage/registry'
import { accountLocalKeyFor } from './accountLocalKeys'
import { bapIdFor, bapKey } from './bapRecords'
import { durableGetItem, durableSetItem } from './durableStorage'
import { retainedMinedHeight } from './issuerAttribution'
import {
  currentIssuerSigningKey,
  type IssuerAttribution,
  type IssuerIdentity,
  type IssuerIdentityPackage,
} from './issuerIdentity'
import {
  issuerAttribution,
  issuerIdentityFor,
  issuerIdentityPackage,
  rememberIssuerIdentityPackage,
} from './issuerIdentities'
import { normalizeBapId, normalizeIssuerIdentityKey } from './issuerMetadata'
import type { ActiveWallet } from './session'
import { runtimeIsCurrent, type WalletRuntime } from './walletRuntime'

/**
 * Issuer identities this wallet controls. Each is a master key: the wallet's
 * own root, or an imported key sealed to this wallet. Its BAP keys derive from
 * that master exactly as 1Sat / Yours wallets derive them, so the same master
 * has the same BAP ID everywhere. The identity itself (key chain, profile,
 * image) is on chain and kept in `issuerIdentities`; this record holds custody.
 */
export type ManagedPublicIdentity = {
  /** Master public key. */
  identityKey: string
  signer: 'wallet' | 'imported'
  /** BRC-78 ciphertext sealed to this wallet account. Never public export. */
  sealedKey?: string
  /** BAP ID, once this wallet has published the identity. */
  published?: string
}
export type PublicIdentityRow = Omit<ManagedPublicIdentity, 'sealedKey'> & {
  bapId: string
  identity: IssuerIdentity | null
}
/** Signing material for new issuance under the selected identity. */
export type IssuanceSigner = {
  /** Master key of the selected identity, as the approval showed it. */
  selected: string
  /** Current BAP signing key: Sigma signer and `issuer` on the asset. */
  identityKey: string
  rootKeyHex: string
  bapId: string
  identity: IssuerIdentity | null
  /** Earlier signing keys and the master, which may have issued this identity's tokens. */
  priorKeys: string[]
}
type Store = {
  version: 2
  owner: string
  chain: 'main' | 'test'
  selected: string
  identities: ManagedPublicIdentity[]
}
type StoreV1 = {
  version: 1
  owner: string
  chain: 'main' | 'test'
  selected: string
  identities: Array<{
    profile?: { identityKey?: unknown }
    signer?: unknown
    sealedKey?: unknown
  }>
}
const MAX_RECORDS = 32
const MAX_STORE_BYTES = 128 * 1024
export const MAX_IDENTITY_BACKUP_BYTES = 4 * 1024 * 1024
const BACKUP_KIND = 'handcash-public-identities-backup'
const listeners = new Set<() => void>()
let generation = 0
const bapIds = new Map<string, string>()
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
  if (!runtime) throw new Error('Unlock the wallet to manage public identities.')
  if (!runtimeIsCurrent(runtime)) throw new Error('Wallet changed; retry on the selected account.')
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
    version: 2,
    owner: active.identityKey.toLowerCase(),
    chain: active.chain,
    selected: active.identityKey.toLowerCase(),
    identities: [],
  }
}
/** v1 held self-signed JSON profiles with an icon URL; only custody carries over. */
function migrateV1(store: StoreV1): Store {
  const identities = (Array.isArray(store.identities) ? store.identities : [])
    .filter((row) => row?.signer === 'wallet' || row?.signer === 'imported')
    .map((row) => ({
      identityKey: String(row.profile?.identityKey ?? ''),
      signer: row.signer as ManagedPublicIdentity['signer'],
      ...(typeof row.sealedKey === 'string' ? { sealedKey: row.sealedKey } : {}),
    }))
  return {
    version: 2,
    owner: store.owner,
    chain: store.chain,
    selected: identities.some((row) => row.identityKey === store.selected)
      ? store.selected
      : store.owner,
    identities,
  }
}
function validateStore(raw: unknown, active: ActiveWallet): Store {
  const input = raw as Store | StoreV1
  const store = input?.version === 1 ? migrateV1(input) : (input as Store)
  if (
    !store ||
    store.version !== 2 ||
    store.owner !== active.identityKey.toLowerCase() ||
    store.chain !== active.chain ||
    !Array.isArray(store.identities) ||
    store.identities.length > MAX_RECORDS ||
    !normalizeIssuerIdentityKey(store.selected)
  )
    throw new Error('Invalid public identity backup.')
  const keys = new Set<string>()
  const identities = store.identities.map((row) => {
    const identityKey = normalizeIssuerIdentityKey(row?.identityKey)
    if (
      !identityKey ||
      identityKey !== row.identityKey ||
      keys.has(identityKey) ||
      !['wallet', 'imported'].includes(row.signer)
    )
      throw new Error('Invalid public identity record.')
    keys.add(identityKey)
    if (row.signer === 'wallet' && identityKey !== store.owner)
      throw new Error('Wallet identity does not match.')
    if (row.signer === 'imported') {
      if (typeof row.sealedKey !== 'string' || row.sealedKey.length > 4096)
        throw new Error('Imported signer is missing.')
    } else if (row.sealedKey !== undefined) throw new Error('Unexpected signing material.')
    const published = normalizeBapId(row.published)
    return {
      identityKey,
      signer: row.signer,
      ...(row.sealedKey ? { sealedKey: row.sealedKey } : {}),
      ...(published ? { published } : {}),
    }
  })
  if (store.selected !== store.owner && !identities.some((row) => row.identityKey === store.selected))
    throw new Error('Selected issuer is not controlled by this wallet.')
  return { version: 2, owner: store.owner, chain: store.chain, selected: store.selected, identities }
}
let cached: { owner: string; raw: string; store: Store } | undefined
function read(active: ActiveWallet): Store {
  const raw = durableGetItem(keyFor(active))
  if (!raw) return empty(active)
  if (raw.length > MAX_STORE_BYTES) throw new Error('Public identity store is too large.')
  if (cached?.owner === keyFor(active) && cached.raw === raw) return structuredClone(cached.store)
  const store = validateStore(JSON.parse(raw), active)
  cached = { owner: keyFor(active), raw, store }
  return structuredClone(store)
}
function write(runtime: WalletRuntime, store: Store) {
  const active = activeOrThrow(runtime)
  const value = JSON.stringify(validateStore(store, active))
  if (value.length > MAX_STORE_BYTES) throw new Error('Public identity store is too large.')
  if (!durableSetItem(keyFor(active), value))
    throw new Error('Could not save public identities. No changes were committed.')
  cached = undefined
  announce()
}
function decryptKey(active: ActiveWallet, row: ManagedPublicIdentity): string {
  if (!row.sealedKey) throw new Error('Imported signer is missing.')
  const plain = Utils.toUTF8(
    EncryptedMessage.decrypt(Utils.toArray(row.sealedKey, 'base64'), PrivateKey.fromHex(active.rootKeyHex)),
  )
  const record = JSON.parse(plain)
  if (record.kind !== 'issuer-signing-key' || record.owner !== active.identityKey.toLowerCase())
    throw new Error('Imported key belongs to another wallet.')
  const key = parsePrivateKey(record.privateKey)
  if (key.toPublicKey().toString().toLowerCase() !== row.identityKey)
    throw new Error('Imported key does not match the identity.')
  return key.toHex().padStart(64, '0')
}
function parsePrivateKey(value: unknown): PrivateKey {
  if (typeof value !== 'string') throw new Error('Add a hex or WIF private signing key.')
  const text = value.trim()
  let hex: string
  if (/^[0-9a-f]{64}$/i.test(text)) hex = text
  else {
    const decoded = Utils.fromBase58Check(text, undefined) as { prefix: number[]; data: number[] }
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
  if (scalar <= 0n || scalar >= BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'))
    throw new Error('Invalid private signing key.')
  const key = PrivateKey.fromHex(hex)
  key.toPublicKey()
  return key
}
function upsert(store: Store, row: ManagedPublicIdentity): Store {
  const identities = store.identities.filter((entry) => entry.identityKey !== row.identityKey)
  if (identities.length >= MAX_RECORDS) throw new Error(`At most ${MAX_RECORDS} issuer identities are supported.`)
  return { ...store, identities: [...identities, row] }
}
function masterOf(active: ActiveWallet, owner: string, row: ManagedPublicIdentity): PrivateKey {
  return PrivateKey.fromHex(row.identityKey === owner ? active.rootKeyHex : decryptKey(active, row))
}
function rowFor(store: Store, identityKey: string): ManagedPublicIdentity {
  const key = normalizeIssuerIdentityKey(identityKey)
  const row = rowsOf(store).find((entry) => entry.identityKey === key)
  if (!row) throw new Error('This wallet does not control that issuer.')
  return row
}
/** BAP ID is a pure function of the master key; derive it once per session. */
function bapIdOf(active: ActiveWallet, owner: string, row: ManagedPublicIdentity): string {
  let id = bapIds.get(row.identityKey)
  if (!id) {
    id = bapIdFor(masterOf(active, owner, row))
    bapIds.set(row.identityKey, id)
  }
  return id
}
function rowsOf(store: Store): ManagedPublicIdentity[] {
  return store.identities.some((row) => row.identityKey === store.owner)
    ? store.identities
    : [{ identityKey: store.owner, signer: 'wallet' as const }, ...store.identities]
}
export function listPublicIdentities(runtime: WalletRuntime | null): PublicIdentityRow[] {
  const active = activeOrThrow(runtime)
  const store = read(active)
  return rowsOf(store).map((record) => {
    const { sealedKey: _sealed, ...row } = record
    return {
      ...row,
      bapId: bapIdOf(active, store.owner, record),
      identity: row.published ? issuerIdentityFor(active.chain, row.published) : null,
    }
  })
}
export function selectedPublicIdentityKey(runtime: WalletRuntime | null): string {
  return read(activeOrThrow(runtime)).selected
}
export function importIssuerPrivateKey(runtime: WalletRuntime, value: string): string {
  const active = activeOrThrow(runtime)
  const key = parsePrivateKey(value)
  const identityKey = key.toPublicKey().toString().toLowerCase()
  const store = read(active)
  if (identityKey === store.owner) {
    if (!store.identities.some((row) => row.identityKey === identityKey))
      write(runtime, upsert(store, { identityKey, signer: 'wallet' }))
    return identityKey
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
  const prior = store.identities.find((row) => row.identityKey === identityKey)
  write(
    runtime,
    upsert(store, {
      identityKey,
      signer: 'imported',
      sealedKey: Utils.toBase64(sealed),
      ...(prior?.published ? { published: prior.published } : {}),
    }),
  )
  return identityKey
}
/** Master private key of an identity this wallet controls. */
/** The master an issuer's BAP keys derive from; `own` when it is this wallet's root. */
export function identityMasterKey(
  runtime: WalletRuntime,
  identityKey: string,
): { master: PrivateKey; own: boolean } {
  const active = activeOrThrow(runtime)
  const store = read(active)
  const row = rowFor(store, identityKey)
  return { master: masterOf(active, store.owner, row), own: row.identityKey === store.owner }
}
/** Store a package this wallet built for `identityKey` and make it the one it issues under. */
export function recordPublishedIdentity(
  runtime: WalletRuntime,
  identityKey: string,
  pkg: IssuerIdentityPackage,
): IssuerIdentity {
  const active = activeOrThrow(runtime)
  const store = read(active)
  const row = rowFor(store, identityKey)
  if (pkg.bapId !== bapIdOf(active, store.owner, row)) throw new Error('The identity belongs to another key.')
  const identity = rememberIssuerIdentityPackage(active.chain, pkg, { pin: true, replace: true })
  if (!identity) throw new Error('The published identity did not verify or could not be saved.')
  if (row.published !== identity.bapId) write(runtime, upsert(store, { ...row, published: identity.bapId }))
  return identity
}
export function selectPublicIdentity(runtime: WalletRuntime, identityKey: string) {
  const active = activeOrThrow(runtime)
  const store = read(active)
  if (identityKey !== store.owner && !store.identities.some((row) => row.identityKey === identityKey))
    throw new Error('This wallet does not control that issuer.')
  write(runtime, { ...store, selected: identityKey })
}
export function removePublicIdentity(runtime: WalletRuntime, identityKey: string) {
  const store = read(activeOrThrow(runtime))
  if (identityKey === store.owner) throw new Error('The wallet identity cannot be removed.')
  write(runtime, {
    ...store,
    selected: store.selected === identityKey ? store.owner : store.selected,
    identities: store.identities.filter((row) => row.identityKey !== identityKey),
  })
}
/** Sealed keys plus the identity packages they publish. */
export function exportPublicIdentityBackup(runtime: WalletRuntime): string {
  const active = activeOrThrow(runtime)
  const store = read(active)
  const packages: Record<string, IssuerIdentityPackage> = {}
  for (const row of rowsOf(store)) {
    const pkg = row.published ? issuerIdentityPackage(active.chain, row.published) : null
    if (pkg) packages[pkg.bapId] = pkg
  }
  return JSON.stringify({ kind: BACKUP_KIND, ...store, packages }, null, 2)
}
export function restorePublicIdentityBackup(runtime: WalletRuntime, raw: unknown) {
  const active = activeOrThrow(runtime)
  const backup = raw as { kind?: unknown; packages?: unknown }
  if (backup?.kind !== BACKUP_KIND) throw new Error('Not a public identity backup.')
  const restored = validateStore(raw, active)
  const packages =
    backup.packages && typeof backup.packages === 'object' && !Array.isArray(backup.packages)
      ? (backup.packages as Record<string, unknown>)
      : {}
  const existing = read(active)
  // Keep identities absent from this backup; never delete a newly imported key.
  const byKey = new Map(existing.identities.map((row) => [row.identityKey, row]))
  for (const row of restored.identities) {
    if (row.signer === 'imported') decryptKey(active, row)
    const prior = byKey.get(row.identityKey)
    const custody = prior?.signer === 'imported' ? prior : row.signer === 'imported' ? row : (prior ?? row)
    const pkg = row.published ? packages[row.published] : undefined
    const identity = pkg ? rememberIssuerIdentityPackage(active.chain, pkg, { pin: true }) : null
    const published =
      prior?.published ??
      (identity && identity.bapId === row.published && identity.bapId === bapIdOf(active, existing.owner, custody)
        ? identity.bapId
        : undefined)
    const { published: _drop, ...rest } = custody
    byKey.set(row.identityKey, { ...rest, ...(published ? { published } : {}) })
  }
  write(runtime, { ...existing, identities: [...byKey.values()] })
}
/** Identity the given master key publishes, when this wallet controls it. */
export function publishedIdentityForIssuer(
  runtime: WalletRuntime | null,
  identityKey: string,
): IssuerIdentity | null {
  if (!runtime || !runtimeIsCurrent(runtime)) return null
  const active = runtime.instance
  try {
    const key = normalizeIssuerIdentityKey(identityKey)
    const bapId = rowsOf(read(active)).find((row) => row.identityKey === key)?.published
    return bapId ? issuerIdentityFor(active.chain, bapId) : null
  } catch {
    return null
  }
}
/**
 * Attribution shown for an asset: the BAP ID its signed tape names, judged
 * against the stored package at the asset's height; otherwise, for an asset
 * signed directly by a master key this wallet holds, that key's identity.
 * Null when the asset names no identity or the store is unreadable.
 */
export function displayIssuerAttribution(
  runtime: WalletRuntime | null,
  asset: { issuer: string; bapId?: string; origin?: string },
): IssuerAttribution | null {
  return issuerAttributionResolver(runtime)(asset)
}

/**
 * `displayIssuerAttribution` for one pass over many assets: the identity store
 * is read once and each issuer, or each stamped origin, is judged once.
 */
export function issuerAttributionResolver(
  runtime: WalletRuntime | null,
): (asset: { issuer: string; bapId?: string; origin?: string }) => IssuerAttribution | null {
  if (!runtime || !runtimeIsCurrent(runtime)) return () => null
  const active = runtime.instance
  let published: Map<string, string> | undefined
  const memo = new Map<string, IssuerAttribution | null>()
  const judge = (asset: { issuer: string; bapId?: string; origin?: string }): IssuerAttribution | null => {
    if (asset.bapId)
      return issuerAttribution(active.chain, {
        bapId: asset.bapId,
        signer: asset.issuer,
        minedHeight: asset.origin ? retainedMinedHeight(asset.origin) : undefined,
      })
    published ??= new Map(
      rowsOf(read(active)).flatMap((row) => (row.published ? [[row.identityKey, row.published] as const] : [])),
    )
    const issuer = normalizeIssuerIdentityKey(asset.issuer)
    const bapId = issuer ? published.get(issuer) : undefined
    const identity = bapId ? issuerIdentityFor(active.chain, bapId) : null
    return identity ? { kind: 'verified', identity } : null
  }
  return (asset) => {
    const key = asset.bapId ? `${asset.issuer}|${asset.bapId}|${asset.origin ?? ''}` : asset.issuer
    if (memo.has(key)) return memo.get(key)!
    let attribution: IssuerAttribution | null
    try {
      attribution = runtimeIsCurrent(runtime) ? judge(asset) : null
    } catch {
      attribution = null
    }
    memo.set(key, attribution)
    return attribution
  }
}

export function displayIssuerIdentity(
  runtime: WalletRuntime | null,
  asset: { issuer: string; bapId?: string; origin?: string },
): IssuerIdentity | null {
  const attribution = displayIssuerAttribution(runtime, asset)
  return attribution?.kind === 'verified' ? attribution.identity : null
}
export function issuanceSigner(runtime: WalletRuntime, expectedKey?: string): IssuanceSigner {
  const active = activeOrThrow(runtime)
  const store = read(active)
  if (expectedKey && expectedKey !== store.selected)
    throw new Error('Issuer identity changed after approval; approve again.')
  const row = rowFor(store, store.selected)
  const master = masterOf(active, store.owner, row)
  const bapId = bapIdOf(active, store.owner, row)
  const identity = publishedIdentityForIssuer(runtime, store.selected)
  if (!identity || identity.revoked)
    return {
      selected: store.selected,
      identityKey: store.selected,
      rootKeyHex: master.toHex().padStart(64, '0'),
      bapId,
      identity: null,
      priorKeys: [],
    }
  const signing = currentIssuerSigningKey(master, identity)
  return {
    selected: store.selected,
    identityKey: signing.toPublicKey().toString(),
    rootKeyHex: signing.toHex().padStart(64, '0'),
    bapId,
    identity,
    priorKeys: [
      store.selected,
      ...identity.keys.slice(0, -1).map((key) => bapKey(master, key.seq).toPublicKey().toString()),
    ],
  }
}
