import { EncryptedMessage, PrivateKey, Utils } from '@bsv/sdk'
import { storageRegistry } from '../storage/registry'
import { accountLocalKeyFor } from './accountLocalKeys'
import { saveBackupFile, type BackupSaveOutcome } from './backupFileSave'
import { bapIdFor, bapKey } from './bapRecords'
import { durableGetItem, durableSetItem } from './durableStorage'
import { retainedMinedHeight } from './issuerAttribution'
import {
  identityKeyPackage,
  parseProfileCertificate,
  signIdentityProfile,
  verifyIdentityProfile,
  type IdentityKeyPackage,
  type IdentityProfileRecord,
  type PackageImage,
} from './identityProfile'
import {
  identityProfileFor,
  identityProfileRecord,
  rememberIdentityProfile,
  storedIdentityProfiles,
} from './identityProfiles'
import {
  currentIssuerSigningKey,
  type IssuerAttribution,
  type IssuerIdentity,
  type IssuerIdentityFields,
  type IssuerIdentityImage,
  type IssuerIdentityPackage,
  type IssuerProfile,
} from './issuerIdentity'
import {
  bapStampVerdict,
  identityKeyProfile,
  issuerIdentityFor,
  issuerIdentityPackage,
  linkedIdentityKey,
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
 * own root, or an imported key sealed to this wallet. The identity key's name
 * and image are its own signed profile (BRC-248 §2), kept pinned in
 * `identityProfiles`. A BAP identity an earlier release published from the
 * same master is a fallback label; its BAP keys derive exactly as 1Sat / Yours
 * wallets derive them. This record holds custody.
 */
export type ManagedPublicIdentity = {
  /** Master public key. */
  identityKey: string
  signer: 'wallet' | 'imported'
  /** BRC-78 ciphertext sealed to this wallet account. Never public export. */
  sealedKey?: string
  /** BAP ID, once this wallet has published a BAP identity from this master. */
  published?: string
}
export type PublicIdentityRow = Omit<ManagedPublicIdentity, 'sealedKey'> & {
  bapId: string
  /** What peers see for this key: its own profile, else its published BAP profile. */
  profile: IssuerProfile | null
  /** The BAP identity this master published, for its key-chain maintenance. */
  identity: IssuerIdentity | null
}
/** Signing material for new issuance under the selected identity (BRC-247). */
export type IssuanceSigner = {
  /** The selected identity key: the Sigma BRC-77 signer and `issuer` on the asset. */
  identityKey: string
  rootKeyHex: string
  /** Its published BAP identity, for the keys that stamped under earlier drafts; BAP keys never stamp. */
  identity: IssuerIdentity | null
  /** BAP keys of this identity that stamped its tokens under earlier drafts of BRC-247. */
  priorKeys: string[]
}
type Store = {
  version: 2
  owner: string
  chain: 'main' | 'test'
  selected: string
  identities: ManagedPublicIdentity[]
  /** The user chose to issue new assets without a BRC-247 stamp. */
  unsigned?: true
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
    (!presentedAt ||
      (store.presented !== store.owner && !identities.some((row) => row.identityKey === store.presented)))
  )
    throw new Error('Presented identity is not controlled by this wallet.')
  return {
    version: 2,
    owner: store.owner,
    chain: store.chain,
    selected: store.selected,
    identities,
    ...(store.unsigned === true ? { unsigned: true as const } : {}),
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
/**
 * The label for a key this wallet controls: its own signed profile, else the
 * BAP identity it published. Null when it has neither, or only a revoked one.
 */
function ownProfile(chain: ActiveWallet['chain'], row: ManagedPublicIdentity): IssuerProfile | null {
  return identityKeyProfile(chain, row.identityKey, row.published ? issuerIdentityFor(chain, row.published) : null)
}

export function listPublicIdentities(runtime: WalletRuntime | null): PublicIdentityRow[] {
  const active = activeOrThrow(runtime)
  const store = read(active)
  return rowsOf(store).map((record) => {
    const { sealedKey: _sealed, ...row } = record
    return {
      ...row,
      bapId: bapIdOf(active, store.owner, record),
      profile: ownProfile(active.chain, record),
      identity: row.published ? issuerIdentityFor(active.chain, row.published) : null,
    }
  })
}
export type AccountProfile = { id: string; name: string; image?: IssuerIdentityImage }

/**
 * The profile a vault account shows in the wallet switcher: the identity it
 * presents. Reads any account's store without unlocking it; null when it
 * presents none.
 */
export function accountProfile(account: StoreScope): AccountProfile | null {
  const profile = presentedProfileOfAccount(account)
  return profile ? { id: profile.id, name: profile.name, ...(profile.image ? { image: profile.image } : {}) } : null
}

/** The profile a vault account presents, read from its own store without unlocking it. */
export function presentedProfileOfAccount(account: StoreScope): IssuerProfile | null {
  try {
    const row = presentedRow(read(account), account.chain)
    return row ? ownProfile(account.chain, row) : null
  } catch {
    return null
  }
}

export function selectedPublicIdentityKey(runtime: WalletRuntime | null): string {
  return read(activeOrThrow(runtime)).selected
}
/** Whether new assets carry a BRC-247 stamp by the selected identity key (the default). */
export function signsIssuance(runtime: WalletRuntime | null): boolean {
  return read(activeOrThrow(runtime)).unsigned !== true
}
export function setSignsIssuance(runtime: WalletRuntime, signs: boolean) {
  const { unsigned: _unsigned, ...store } = read(activeOrThrow(runtime))
  write(runtime, signs ? store : { ...store, unsigned: true })
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

/**
 * Sign and keep `identityKey`'s own profile (BRC-248 §2): its master
 * certifies the name, bio and image about itself. Nothing touches the chain.
 * The new profile is strictly later than the one it replaces, so every peer
 * that sees both keeps this one.
 */
export async function saveIdentityProfile(
  runtime: WalletRuntime,
  identityKey: string,
  fields: IssuerIdentityFields,
  image: IssuerIdentityImage | null,
): Promise<IssuerProfile> {
  const active = activeOrThrow(runtime)
  const store = read(active)
  const row = rowFor(store, identityKey)
  const prior = identityProfileFor(active.chain, row.identityKey)
  const floor = prior ? Date.parse(prior.issuedAt) + 1 : 0
  const signed = await signIdentityProfile({
    master: masterOf(active, store.owner, row),
    fields,
    image,
    issuedAt: new Date(Math.max(Date.now(), floor)).toISOString(),
  })
  if (!runtimeIsCurrent(runtime)) throw new Error('Wallet changed; retry on the selected account.')
  if (!rememberIdentityProfile(active.chain, signed, { pin: true }))
    throw new Error('Could not save the profile. No changes were committed.')
  autoPresent(runtime)
  announce()
  return ownProfile(active.chain, row)!
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
 * Every identity with a profile is shared; there is no opt-out. Which one: the
 * one chosen with `presentPublicIdentity`, else the wallet's own, else an
 * imported one. A key whose only profile is a revoked BAP identity is never
 * shared.
 */
function presentedRow(store: Store, chain: ActiveWallet['chain']): ManagedPublicIdentity | null {
  const live = (row: ManagedPublicIdentity) => !!ownProfile(chain, row)
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
/** Choose which identity contacts see. */
export function presentPublicIdentity(runtime: WalletRuntime, identityKey: string) {
  const active = activeOrThrow(runtime)
  const store = read(active)
  const key = normalizeIssuerIdentityKey(identityKey)
  const row = rowsOf(store).find((entry) => entry.identityKey === key)
  if (!row || !ownProfile(active.chain, row)) throw new Error('Add a profile to this identity before presenting it.')
  if (store.presented === key) return
  write(runtime, { ...store, presented: key!, presentedAt: nextPresentedAt(store.presentedAt) })
}

/**
 * The package peers receive for a key this wallet controls: its own profile,
 * plus its live BAP identity when both fit `budget`.
 */
function ownIdentityPackage(
  chain: ActiveWallet['chain'],
  row: ManagedPublicIdentity,
  budget?: number,
): IdentityKeyPackage | null {
  const bap = row.published ? issuerIdentityFor(chain, row.published) : null
  const bapPkg = bap && !bap.revoked ? issuerIdentityPackage(chain, bap.bapId) : null
  return identityKeyPackage(
    row.identityKey,
    {
      profile: identityProfileRecord(chain, row.identityKey),
      bap: bapPkg ? { bapId: bapPkg.bapId, beefB64: bapPkg.beefB64 } : null,
    },
    budget,
  )
}

export type PresentedIdentityMaterial =
  | {
      kind: 'presented'
      issuedAt: string
      /** The presented identity key; its master countersigns when it is not the wallet key. */
      identityKey: string
      pkg: IdentityKeyPackage
      profile: IssuerProfile
      signingKey: PrivateKey
    }
  | { kind: 'withdrawn'; issuedAt: string }
/**
 * What this wallet's identity card says now; null before it ever presented
 * one. The package stays within `packageBudget` serialized bytes.
 */
export function presentedIdentityMaterial(
  runtime: WalletRuntime,
  opts?: { packageBudget?: number },
): PresentedIdentityMaterial | null {
  autoPresent(runtime)
  const active = activeOrThrow(runtime)
  const store = read(active)
  if (!store.presentedAt) return null
  if (!store.presented) return { kind: 'withdrawn', issuedAt: store.presentedAt }
  const row = rowFor(store, store.presented)
  const profile = ownProfile(active.chain, row)
  const pkg = ownIdentityPackage(active.chain, row, opts?.packageBudget)
  if (!profile || !pkg) return null
  return {
    kind: 'presented',
    issuedAt: store.presentedAt,
    identityKey: row.identityKey,
    pkg,
    profile,
    signingKey: masterOf(active, store.owner, row),
  }
}

export type PresentedBapMaterial =
  | { kind: 'ready'; identity: IssuerIdentity; signingKey: PrivateKey }
  | { kind: 'none' }
  | { kind: 'revoked'; identity: IssuerIdentity }
/**
 * The BAP identity behind the presented key and its current BAP signing key,
 * for servers that sign as that BAP identity.
 */
export function presentedBapMaterial(runtime: WalletRuntime): PresentedBapMaterial {
  autoPresent(runtime)
  const active = activeOrThrow(runtime)
  const store = read(active)
  if (!store.presented) return { kind: 'none' }
  const row = rowFor(store, store.presented)
  const identity = row.published ? issuerIdentityFor(active.chain, row.published) : null
  if (!identity) return { kind: 'none' }
  if (identity.revoked) return { kind: 'revoked', identity }
  return { kind: 'ready', identity, signingKey: currentIssuerSigningKey(masterOf(active, store.owner, row), identity) }
}
/**
 * `identity-<seq>` of the presented identity, current or retired, so a key
 * handed to a server stays reachable after a rotation. Null when another
 * identity is presented.
 */
export function presentedIdentityKeyAt(
  runtime: WalletRuntime,
  bapId: string,
  seq: number,
): PrivateKey | null {
  autoPresent(runtime)
  const active = activeOrThrow(runtime)
  const store = read(active)
  if (!store.presented) return null
  const row = rowFor(store, store.presented)
  if (row.published !== bapId) return null
  return bapKey(masterOf(active, store.owner, row), seq)
}
/** Sealed keys plus the profiles and BAP packages they publish. */
export function exportPublicIdentityBackup(runtime: WalletRuntime): string {
  const active = activeOrThrow(runtime)
  const store = read(active)
  const packages: Record<string, IssuerIdentityPackage> = {}
  const profiles: Record<string, IdentityProfileRecord> = {}
  for (const row of rowsOf(store)) {
    const pkg = row.published ? issuerIdentityPackage(active.chain, row.published) : null
    if (pkg) packages[pkg.bapId] = pkg
    const profile = identityProfileRecord(active.chain, row.identityKey)
    if (profile) profiles[row.identityKey] = profile
  }
  return JSON.stringify({ kind: BACKUP_KIND, ...store, packages, profiles }, null, 2)
}

/** Save the issuer backup where the user picks; `saved` only once it reads back intact. */
export function saveIssuerIdentityBackup(runtime: WalletRuntime): Promise<BackupSaveOutcome> {
  return saveBackupFile('handcash-issuer-backup.json', exportPublicIdentityBackup(runtime))
}

/** Profiles in a backup that verify for a key the restored store controls. */
async function restoreProfiles(
  chain: ActiveWallet['chain'],
  controlled: ReadonlySet<string>,
  raw: unknown,
): Promise<void> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  for (const [identityKey, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!controlled.has(identityKey)) continue
    const record = entry as { certificate?: unknown; image?: PackageImage }
    const certificate = parseProfileCertificate(record?.certificate)
    const verified = certificate
      ? await verifyIdentityProfile(identityKey, certificate, record.image ? [record.image] : [])
      : null
    if (verified) rememberIdentityProfile(chain, verified, { pin: true })
  }
}

export async function restorePublicIdentityBackup(runtime: WalletRuntime, raw: unknown): Promise<void> {
  const active = activeOrThrow(runtime)
  const backup = raw as { kind?: unknown; packages?: unknown; profiles?: unknown }
  if (backup?.kind !== BACKUP_KIND) throw new Error('Not a public identity backup.')
  const restored = validateStore(raw, active)
  const packages =
    backup.packages && typeof backup.packages === 'object' && !Array.isArray(backup.packages)
      ? (backup.packages as Record<string, unknown>)
      : {}
  await restoreProfiles(
    active.chain,
    new Set([restored.owner, ...restored.identities.map((row) => row.identityKey)]),
    backup.profiles,
  )
  if (!runtimeIsCurrent(runtime)) throw new Error('Wallet changed; retry on the selected account.')
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
 * `identityKeyProfile`, where keys this wallet controls count their published
 * BAP identity as linked, since this wallet holds both keys.
 */
function profileForKey(
  chain: ActiveWallet['chain'],
  identityKey: string,
  ownBapId: string | undefined,
  stampBap?: IssuerIdentity,
): IssuerProfile | null {
  return identityKeyProfile(
    chain,
    identityKey,
    stampBap ?? (ownBapId ? issuerIdentityFor(chain, ownBapId) : undefined),
  )
}

/** The label a key shows, for this wallet's own keys and any peer whose profile it holds. */
export function issuerProfileForKey(runtime: WalletRuntime | null, identityKey: string): IssuerProfile | null {
  if (!runtime || !runtimeIsCurrent(runtime)) return null
  const active = runtime.instance
  const key = normalizeIssuerIdentityKey(identityKey)
  if (!key) return null
  try {
    const own = rowsOf(read(active)).find((row) => row.identityKey === key)
    return own ? ownProfile(active.chain, own) : profileForKey(active.chain, key, undefined)
  } catch {
    return null
  }
}

/**
 * Attribution shown for an asset (BRC-247, BRC-248). A stamp by an identity
 * key is labelled by that key's own signed profile, else its linked BAP
 * profile. A stamp from an earlier draft names a BAP ID and is signed by a BAP
 * key: it is judged against the stored package at the asset's height, then
 * belongs to the identity key that BAP identity links and takes that key's
 * label. This wallet's own identities count as linked: it holds both keys.
 * Null when nothing labels the asset or the store is unreadable.
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
  let own: { byKey: Map<string, string>; byBap: Map<string, string> } | undefined
  const ownRows = () => {
    if (own) return own
    const rows = rowsOf(read(active)).flatMap((row) => (row.published ? [[row.identityKey, row.published] as const] : []))
    own = { byKey: new Map(rows), byBap: new Map(rows.map(([key, bapId]) => [bapId, key])) }
    return own
  }
  const memo = new Map<string, IssuerAttribution | null>()
  const judge = (asset: { issuer: string; bapId?: string; origin?: string }): IssuerAttribution | null => {
    const issuer = normalizeIssuerIdentityKey(asset.issuer)
    if (!issuer) return null
    if (asset.bapId) {
      const verdict = bapStampVerdict(active.chain, {
        bapId: asset.bapId,
        signer: issuer,
        minedHeight: asset.origin ? retainedMinedHeight(asset.origin) : undefined,
      })
      if (verdict?.kind !== 'verified') return verdict
      const identityKey = ownRows().byBap.get(verdict.identity.bapId) ?? linkedIdentityKey(verdict.identity)
      const profile = identityKey ? profileForKey(active.chain, identityKey, undefined, verdict.identity) : null
      return identityKey && profile
        ? { kind: 'verified', identityKey, profile }
        : { kind: 'unconfirmed', bapId: verdict.identity.bapId, reason: 'not-linked' }
    }
    const profile = profileForKey(active.chain, issuer, ownRows().byKey.get(issuer))
    return profile ? { kind: 'verified', identityKey: issuer, profile } : null
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
        const chain = runtime.instance.chain
        const profiles = storedIdentityProfiles(chain)
        const keyed = new Set(profiles.map((p) => p.identityKey))
        // A BAP identity linked to a key with its own profile labels nothing on its own.
        const bap = storedIssuerIdentities(chain).filter(
          (i) => !i.links.some((link) => keyed.has(link.identityKey)),
        )
        return [
          ...profiles.map((p) => ({ id: p.identityKey, name: p.name })),
          ...bap.map((i) => ({ id: i.bapId, name: i.name })),
        ]
      } catch {
        return []
      }
    },
  })
}

export function displayIssuerProfile(
  runtime: WalletRuntime | null,
  asset: { issuer: string; bapId?: string; origin?: string },
): IssuerProfile | null {
  const attribution = displayIssuerAttribution(runtime, asset)
  return attribution?.kind === 'verified' ? attribution.profile : null
}
export function issuanceSigner(runtime: WalletRuntime, expectedKey?: string): IssuanceSigner {
  const active = activeOrThrow(runtime)
  const store = read(active)
  if (expectedKey && expectedKey !== store.selected)
    throw new Error('Issuer identity changed after approval; approve again.')
  const row = rowFor(store, store.selected)
  const master = masterOf(active, store.owner, row)
  const identity = publishedIdentityForIssuer(runtime, store.selected)
  return {
    identityKey: store.selected,
    rootKeyHex: master.toHex().padStart(64, '0'),
    identity: identity && !identity.revoked ? identity : null,
    priorKeys: identity ? identity.keys.map((key) => bapKey(master, key.seq).toPublicKey().toString()) : [],
  }
}
