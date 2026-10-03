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
  type IssuerIdentityImage,
  type IssuerIdentityPackage,
} from './issuerIdentity'
import {
  issuerAttribution,
  issuerIdentityFor,
  issuerIdentityPackage,
  rememberIssuerIdentityPackage,
  storedIssuerIdentities,
} from './issuerIdentities'
import { normalizeBapId, normalizeIssuerIdentityKey } from './issuerMetadata'
import { issuerTrustFrom, type IssuerTrust } from './issuerTrust'
import { listedVerifiedIssuers, verifiedIssuerFor } from './verifiedIssuers'
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
  /** Master key whose published identity this wallet presents to peers. */
  presented?: string
  /** When `presented` last changed; the identity card's statement time. */
  presentedAt?: string
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
/** The account whose store is read; every vault account has one, unlocked or not. */
type StoreScope = Pick<ActiveWallet, 'identityKey' | 'chain'> & { accountIndex?: number }
function keyFor(active: StoreScope): string {
  return accountLocalKeyFor(storageRegistry.publicIdentities.key, {
    identityKey: active.identityKey,
    accountIndex: active.accountIndex ?? 0,
    chain: active.chain,
  })
}
function empty(active: StoreScope): Store {
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
function validateStore(raw: unknown, active: StoreScope): Store {
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
  const presentedAt = store.presentedAt === undefined ? undefined : canonicalTime(store.presentedAt)
  if (store.presentedAt !== undefined && !presentedAt) throw new Error('Invalid presented identity time.')
  if (
    store.presented !== undefined &&
    (!presentedAt || !identities.some((row) => row.identityKey === store.presented && row.published))
  )
    throw new Error('Presented identity is not published by this wallet.')
  return {
    version: 2,
    owner: store.owner,
    chain: store.chain,
    selected: store.selected,
    identities,
    ...(store.presented !== undefined ? { presented: store.presented } : {}),
    ...(presentedAt ? { presentedAt } : {}),
  }
}
function canonicalTime(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? value : null
}
let cached: { owner: string; raw: string; store: Store } | undefined
function read(active: StoreScope): Store {
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
export type AccountProfile = { bapId: string; name: string; image?: IssuerIdentityImage }

/**
 * The profile a vault account shows in the wallet switcher: the identity it
 * presents, else its own key's published identity. Reads any account's store
 * without unlocking it; null when nothing verified is published.
 */
export function accountProfile(account: StoreScope): AccountProfile | null {
  try {
    const row = presentedRow(read(account), account.chain)
    const identity = row?.published ? issuerIdentityFor(account.chain, row.published) : null
    if (!identity || identity.revoked) return null
    return { bapId: identity.bapId, name: identity.name, ...(identity.image ? { image: identity.image } : {}) }
  } catch {
    return null
  }
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
  autoPresent(runtime)
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
  const { presented, presentedAt, ...rest } = store
  write(runtime, {
    ...rest,
    selected: store.selected === identityKey ? store.owner : store.selected,
    identities: store.identities.filter((row) => row.identityKey !== identityKey),
    ...(presented === identityKey
      ? { presentedAt: nextPresentedAt(presentedAt) }
      : { ...(presented ? { presented } : {}), ...(presentedAt ? { presentedAt } : {}) }),
  })
  autoPresent(runtime)
}
/** Strictly after the previous statement, so peers never see two cards at one time. */
function nextPresentedAt(previous: string | undefined): string {
  const floor = previous ? Date.parse(previous) + 1 : 0
  return new Date(Math.max(Date.now(), floor)).toISOString()
}
/**
 * Every published identity is shared; there is no opt-out. Which one: the one
 * chosen with `presentPublicIdentity`, else the wallet's own, else an imported
 * one. A revoked identity is never shared.
 */
function presentedRow(store: Store, chain: ActiveWallet['chain']): ManagedPublicIdentity | null {
  const live = (row: ManagedPublicIdentity) => !!row.published && !issuerIdentityFor(chain, row.published)?.revoked
  const rows = rowsOf(store)
  return (
    rows.find((row) => row.identityKey === store.presented && live(row)) ??
    rows.find((row) => row.identityKey === store.owner && live(row)) ??
    rows.find(live) ??
    null
  )
}
/** Persist the shared identity with a strictly later statement whenever it changes. */
function autoPresent(runtime: WalletRuntime) {
  const active = activeOrThrow(runtime)
  const store = read(active)
  const key = presentedRow(store, active.chain)?.identityKey ?? null
  if ((store.presented ?? null) === key) return
  const { presented: _drop, ...rest } = store
  write(runtime, {
    ...rest,
    ...(key ? { presented: key } : {}),
    presentedAt: nextPresentedAt(store.presentedAt),
  })
}
export function presentedPublicIdentityKey(runtime: WalletRuntime | null): string | null {
  const active = activeOrThrow(runtime)
  return presentedRow(read(active), active.chain)?.identityKey ?? null
}
/** Choose which published identity contacts see. */
export function presentPublicIdentity(runtime: WalletRuntime, identityKey: string) {
  const store = read(activeOrThrow(runtime))
  const key = normalizeIssuerIdentityKey(identityKey)
  if (!rowsOf(store).some((row) => row.identityKey === key && row.published))
    throw new Error('Publish this identity before presenting it.')
  if (store.presented === key) return
  write(runtime, { ...store, presented: key!, presentedAt: nextPresentedAt(store.presentedAt) })
}
export type PresentedIdentityMaterial =
  | {
      kind: 'presented'
      issuedAt: string
      pkg: IssuerIdentityPackage
      identity: IssuerIdentity
      signingKey: PrivateKey
    }
  | { kind: 'withdrawn'; issuedAt: string }
/** What this wallet's identity card says now; null before it ever presented one. */
export function presentedIdentityMaterial(runtime: WalletRuntime): PresentedIdentityMaterial | null {
  autoPresent(runtime)
  const active = activeOrThrow(runtime)
  const store = read(active)
  if (!store.presentedAt) return null
  if (!store.presented) return { kind: 'withdrawn', issuedAt: store.presentedAt }
  const row = rowFor(store, store.presented)
  const pkg = row.published ? issuerIdentityPackage(active.chain, row.published) : null
  const identity = row.published ? issuerIdentityFor(active.chain, row.published) : null
  if (!pkg || !identity || identity.revoked) return null
  return {
    kind: 'presented',
    issuedAt: store.presentedAt,
    pkg,
    identity,
    signingKey: currentIssuerSigningKey(masterOf(active, store.owner, row), identity),
  }
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
  autoPresent(runtime)
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

/** HandCash listing and look-alike names for one pass; stored identities are read once. */
export function issuerTrustResolver(runtime: WalletRuntime | null): IssuerTrust {
  return issuerTrustFrom({
    listed: verifiedIssuerFor,
    listedEntries: listedVerifiedIssuers(),
    storedIdentities: () => {
      if (!runtime || !runtimeIsCurrent(runtime)) return []
      try {
        return storedIssuerIdentities(runtime.instance.chain)
      } catch {
        return []
      }
    },
  })
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
