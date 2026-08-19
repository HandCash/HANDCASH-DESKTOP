/**
 * Sealed mutual device-key backups (cold only).
 *
 * Each linked peer can hold an EncryptedMessage (BRC-78) of this device's
 * custody secret, sealed to the peer's identity pubkey. Day-to-day spend never
 * loads the peer's key — only an explicit Recover action decrypts.
 *
 * Identity link and sealed backup are separate contracts; the pair wizard
 * offers both.
 */
import { EncryptedMessage, PrivateKey, PublicKey, Utils } from '@bsv/sdk'
import { durableGetItem, durableSetItem } from './durableStorage'
import { unlockVault } from './vault'
import { getActiveWallet } from './session'

const STORE_KEY = 'handcash.brc100.deviceKeyBackups.v1'
/** Local attestation that we sealed+handed our spare to this peer (they can recover us). */
const GIVEN_KEY = 'handcash.brc100.deviceKeySparesGiven.v1'
const DEVICE_ID_KEY = 'handcash.brc100.deviceId.v1'

export type DeviceKeyBackupPackage = {
  v: 1
  kind: 'handcash-device-key-backup'
  fromDeviceId: string
  fromIdentityKey: string
  fromAddress: string
  fromLabel: string
  forIdentityKey: string
  sealedAt: number
  /** Base64 EncryptedMessage ciphertext. */
  ciphertextB64: string
}

export type SpareGivenRecord = {
  peerDeviceId: string
  peerIdentityKey: string
  givenAt: number
}

/** Both legs of a mutual spare exchange for one peer. */
export type MutualSpareStatus = {
  /** We store their sealed spare → we can recover them. */
  holdTheirs: boolean
  /** We sealed our spare to them → they can recover us (local attestation). */
  gaveMine: boolean
  complete: boolean
}

type CustodySecret = {
  v: 1
  rootKeyHex: string
  mnemonic: string | null
  identityKey: string
  address: string
}

type StoreMap = Record<string, DeviceKeyBackupPackage>
type GivenMap = Record<string, SpareGivenRecord>

type BackupListener = () => void
const listeners = new Set<BackupListener>()

function notify() {
  for (const l of listeners) l()
}

export function subscribeDeviceKeyBackups(listener: BackupListener): () => void {
  listeners.add(listener)
  listener()
  return () => {
    listeners.delete(listener)
  }
}

function readStore(): StoreMap {
  try {
    const raw = durableGetItem(STORE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as StoreMap
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

function writeStore(map: StoreMap) {
  durableSetItem(STORE_KEY, JSON.stringify(map))
  notify()
}

function readGiven(): GivenMap {
  try {
    const raw = durableGetItem(GIVEN_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as GivenMap
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

function writeGiven(map: GivenMap) {
  durableSetItem(GIVEN_KEY, JSON.stringify(map))
  notify()
}

function localDeviceId(): string {
  const existing = durableGetItem(DEVICE_ID_KEY)?.trim()
  if (existing) return existing
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `dev-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`
  durableSetItem(DEVICE_ID_KEY, id)
  return id
}

function isPubkey(s: string): boolean {
  return /^(02|03)[0-9a-fA-F]{64}$/.test(s)
}

function bytesToUtf8(bytes: number[]): string {
  return Utils.toUTF8(bytes)
}

export function listStoredDeviceKeyBackups(): DeviceKeyBackupPackage[] {
  return Object.values(readStore()).sort((a, b) => b.sealedAt - a.sealedAt)
}

export function getDeviceKeyBackup(peerDeviceId: string): DeviceKeyBackupPackage | null {
  return readStore()[peerDeviceId] ?? null
}

export function hasDeviceKeyBackup(peerDeviceId: string): boolean {
  return Boolean(readStore()[peerDeviceId])
}

export function hasSpareGivenToPeer(peerDeviceId: string): boolean {
  return Boolean(readGiven()[peerDeviceId])
}

export function getMutualSpareStatus(peerDeviceId: string): MutualSpareStatus {
  const holdTheirs = hasDeviceKeyBackup(peerDeviceId)
  const gaveMine = hasSpareGivenToPeer(peerDeviceId)
  return { holdTheirs, gaveMine, complete: holdTheirs && gaveMine }
}

/** Record that we sealed our spare for this peer (they still must import it). */
export function markSpareGivenToPeer(peerDeviceId: string, peerIdentityKey: string): void {
  const id = peerDeviceId.trim()
  const ik = peerIdentityKey.trim()
  if (!id || !isPubkey(ik)) return
  const map = readGiven()
  map[id] = { peerDeviceId: id, peerIdentityKey: ik, givenAt: Date.now() }
  writeGiven(map)
}

export function removeDeviceKeyBackup(peerDeviceId: string): void {
  const map = readStore()
  const given = readGiven()
  let changed = false
  if (peerDeviceId in map) {
    delete map[peerDeviceId]
    writeStore(map)
    changed = true
  }
  if (peerDeviceId in given) {
    delete given[peerDeviceId]
    writeGiven(given)
    changed = true
  }
  if (!changed) return
}

/** Clear both legs when unlinking a peer. */
export function clearSpareExchangeForPeer(peerDeviceId: string): void {
  removeDeviceKeyBackup(peerDeviceId)
}

export function tryParseDeviceKeyBackupPackage(raw: string): DeviceKeyBackupPackage | null {
  const text = raw.trim()
  if (!text.startsWith('{') || !text.includes('handcash-device-key-backup')) return null
  try {
    return parseDeviceKeyBackupPackage(text)
  } catch {
    return null
  }
}

export function parseDeviceKeyBackupPackage(raw: string): DeviceKeyBackupPackage {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.trim())
  } catch {
    throw new Error('Backup code must be HandCash sealed-key JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid sealed-key backup')
  }
  const o = parsed as Record<string, unknown>
  if (o.v !== 1 || o.kind !== 'handcash-device-key-backup') {
    throw new Error('Unsupported sealed-key backup version')
  }
  if (typeof o.fromDeviceId !== 'string' || !o.fromDeviceId.trim()) {
    throw new Error('Sealed backup missing fromDeviceId')
  }
  if (typeof o.fromIdentityKey !== 'string' || !isPubkey(o.fromIdentityKey)) {
    throw new Error('Sealed backup fromIdentityKey is invalid')
  }
  if (typeof o.forIdentityKey !== 'string' || !isPubkey(o.forIdentityKey)) {
    throw new Error('Sealed backup forIdentityKey is invalid')
  }
  if (typeof o.ciphertextB64 !== 'string' || !o.ciphertextB64.trim()) {
    throw new Error('Sealed backup missing ciphertext')
  }
  if (typeof o.fromAddress !== 'string' || !o.fromAddress.trim()) {
    throw new Error('Sealed backup missing address')
  }
  return {
    v: 1,
    kind: 'handcash-device-key-backup',
    fromDeviceId: o.fromDeviceId.trim(),
    fromIdentityKey: o.fromIdentityKey,
    fromAddress: o.fromAddress.trim(),
    fromLabel:
      typeof o.fromLabel === 'string' && o.fromLabel.trim() ? o.fromLabel.trim() : 'Device',
    forIdentityKey: o.forIdentityKey,
    sealedAt: typeof o.sealedAt === 'number' && Number.isFinite(o.sealedAt) ? o.sealedAt : Date.now(),
    ciphertextB64: o.ciphertextB64.trim(),
  }
}

export function deviceKeyBackupToQrText(pkg: DeviceKeyBackupPackage): string {
  return JSON.stringify(pkg)
}

/**
 * Seal this device's custody secret to a peer identity pubkey.
 * Requires unlock password (proves operator + loads root).
 */
export async function createSealedBackupForPeer(args: {
  password: string
  peerIdentityKey: string
  peerDeviceId: string
  label?: string
}): Promise<DeviceKeyBackupPackage> {
  const peerIk = args.peerIdentityKey.trim()
  const peerDeviceId = args.peerDeviceId.trim()
  if (!isPubkey(peerIk)) throw new Error('Peer identity key is invalid')
  if (!peerDeviceId) throw new Error('Peer device id is required')

  const unlocked = await unlockVault(args.password)
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock this wallet first')
  if (unlocked.rootKeyHex !== active.rootKeyHex) {
    throw new Error('Session does not match vault — unlock again')
  }
  if (peerIk.toLowerCase() === active.identityKey.toLowerCase()) {
    throw new Error('Cannot seal a spare key to this same identity')
  }

  const secret: CustodySecret = {
    v: 1,
    rootKeyHex: unlocked.rootKeyHex,
    mnemonic: unlocked.mnemonic,
    identityKey: active.identityKey,
    address: active.address,
  }
  const sender = PrivateKey.fromHex(unlocked.rootKeyHex)
  const recipient = PublicKey.fromString(peerIk)
  const cipher = EncryptedMessage.encrypt(
    Utils.toArray(JSON.stringify(secret), 'utf8'),
    sender,
    recipient,
  )

  const pkg: DeviceKeyBackupPackage = {
    v: 1,
    kind: 'handcash-device-key-backup',
    fromDeviceId: localDeviceId(),
    fromIdentityKey: active.identityKey,
    fromAddress: active.address,
    fromLabel: args.label?.trim() || 'Device',
    forIdentityKey: peerIk,
    sealedAt: Date.now(),
    ciphertextB64: Utils.toBase64(cipher),
  }
  // Mutual exchange: mark our outbound leg. Import marks the inbound leg.
  markSpareGivenToPeer(peerDeviceId, peerIk)
  return pkg
}

/** Store a peer's sealed spare on this device (cold). */
export function importSealedDeviceKeyBackup(raw: string): DeviceKeyBackupPackage {
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock this wallet first')

  const pkg = parseDeviceKeyBackupPackage(raw)
  if (pkg.forIdentityKey.toLowerCase() !== active.identityKey.toLowerCase()) {
    throw new Error('That sealed spare was encrypted for a different identity')
  }
  if (pkg.fromIdentityKey.toLowerCase() === active.identityKey.toLowerCase()) {
    throw new Error('Refusing to store a sealed spare of this same identity')
  }
  if (pkg.fromDeviceId === localDeviceId()) {
    throw new Error('Cannot import a sealed spare from this device')
  }

  const map = readStore()
  map[pkg.fromDeviceId] = pkg
  writeStore(map)
  return pkg
}

export type OpenedDeviceKeyBackup = {
  package: DeviceKeyBackupPackage
  rootKeyHex: string
  mnemonic: string | null
  identityKey: string
  address: string
}

/**
 * Decrypt a stored peer spare with this device's private key.
 * Never installs the peer wallet — caller shows keys for restore elsewhere.
 */
export async function openStoredDeviceKeyBackup(args: {
  peerDeviceId: string
  password: string
}): Promise<OpenedDeviceKeyBackup> {
  const pkg = getDeviceKeyBackup(args.peerDeviceId)
  if (!pkg) throw new Error('No sealed spare for that device')

  const unlocked = await unlockVault(args.password)
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock this wallet first')
  if (unlocked.rootKeyHex !== active.rootKeyHex) {
    throw new Error('Session does not match vault — unlock again')
  }
  if (pkg.forIdentityKey.toLowerCase() !== active.identityKey.toLowerCase()) {
    throw new Error('Stored spare is not sealed for this identity')
  }

  const recipient = PrivateKey.fromHex(unlocked.rootKeyHex)
  let plain: number[]
  try {
    plain = EncryptedMessage.decrypt(Utils.toArray(pkg.ciphertextB64, 'base64'), recipient)
  } catch {
    throw new Error('Could not open sealed spare — wrong device or corrupt backup')
  }

  let secret: CustodySecret
  try {
    secret = JSON.parse(bytesToUtf8(plain)) as CustodySecret
  } catch {
    throw new Error('Sealed spare payload is corrupt')
  }
  if (secret?.v !== 1 || typeof secret.rootKeyHex !== 'string') {
    throw new Error('Sealed spare payload is unsupported')
  }
  if (secret.identityKey.toLowerCase() !== pkg.fromIdentityKey.toLowerCase()) {
    throw new Error('Sealed spare identity does not match package')
  }

  return {
    package: pkg,
    rootKeyHex: secret.rootKeyHex,
    mnemonic: typeof secret.mnemonic === 'string' ? secret.mnemonic : null,
    identityKey: secret.identityKey,
    address: secret.address,
  }
}
