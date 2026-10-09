import { getActiveWallet } from './session'

/**
 * Directional sealed device-key backups (cold only).
 *
 * Each linked peer can hold an EncryptedMessage (BRC-78) of this device's
 * custody secret, sealed to the peer's identity pubkey. Day-to-day spend never
 * loads the peer's key — only an explicit Recover action decrypts.
 *
 * Identity link and sealed backup are separate contracts; the pair wizard
 * offers both.
 */
import { EncryptedMessage, PrivateKey, PublicKey, Utils } from '@bsv/sdk'
import {
  accountRootKeyHex,
  parseVaultMaster,
  sameVaultMaster,
  vaultIdentityKey,
  type VaultMaster,
} from './vaultMaster'
import { durableGetItem, durableSetItem } from './durableStorage'
import { getOpenUnlockSecret, isNoDeviceLock } from './deviceLockPrefs'
import {
  readVaultUnlockFactors,
  unlockVault,
  unlockVaultWithDevice,
  type UnlockedVault,
} from './vault'


const STORE_KEY = 'handcash.brc100.deviceKeyBackups.v1'
/** Local attestation that we sealed+handed our spare to this peer (they can recover us). */
const GIVEN_KEY = 'handcash.brc100.deviceKeySparesGiven.v1'
/** Safety tombstone: this device has received a recovery copy from this peer. */
const RECEIVED_KEY = 'handcash.brc100.deviceKeySparesReceived.v1'
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
  /**
   * Holder confirmed the peer stored the copy. `false` = sealed and shown only.
   * Absent on records written before confirmation existed; those count as stored.
   */
  confirmed?: boolean
}

export type DeviceBackupRoleStatus = {
  /** This device stores the peer wallet's sealed recovery copy. */
  protectsPeer: boolean
  /** This direction was selected, even if the local copy was later deleted. */
  recoveryCopyReceivedFromPeer: boolean
  /** A sealed recovery copy of this wallet was issued to the peer. */
  recoveryCopyIssuedToPeer: boolean
  /** The holder confirmed the peer stored that copy. */
  recoveryCopyStoredByPeer: boolean
  direction:
    | 'none'
    | 'this-wallet-to-peer'
    | 'peer-wallet-to-this-device'
    | 'reciprocal'
}

/** `rootKeyHex` is the vault master's key; a BRC-157 entropy key when `derivation` says so. */
type CustodySecret = {
  v: 1
  rootKeyHex: string
  mnemonic: string | null
  /** Account 0's identity and address. */
  identityKey: string
  address: string
  derivation?: 'brc-157'
  entropyLength?: number
}

type StoreMap = Record<string, DeviceKeyBackupPackage>
type GivenMap = Record<string, SpareGivenRecord>
type ReceivedMap = Record<string, { peerDeviceId: string; receivedAt: number }>

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

function readReceived(): ReceivedMap {
  try {
    const raw = durableGetItem(RECEIVED_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as ReceivedMap
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

function markRecoveryCopyReceived(peerDeviceId: string): void {
  const id = peerDeviceId.trim()
  if (!id) return
  const map = readReceived()
  map[id] = { peerDeviceId: id, receivedAt: Date.now() }
  durableSetItem(RECEIVED_KEY, JSON.stringify(map))
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

export function getDeviceBackupRoleStatus(peerDeviceId: string): DeviceBackupRoleStatus {
  const protectsPeer = hasDeviceKeyBackup(peerDeviceId)
  const recoveryCopyReceivedFromPeer = protectsPeer || Boolean(readReceived()[peerDeviceId])
  const given = readGiven()[peerDeviceId]
  const recoveryCopyIssuedToPeer = Boolean(given)
  const recoveryCopyStoredByPeer = Boolean(given) && given.confirmed !== false
  const direction =
    recoveryCopyReceivedFromPeer && recoveryCopyIssuedToPeer
      ? 'reciprocal'
      : recoveryCopyReceivedFromPeer
        ? 'peer-wallet-to-this-device'
        : recoveryCopyIssuedToPeer
          ? 'this-wallet-to-peer'
          : 'none'
  return {
    protectsPeer,
    recoveryCopyReceivedFromPeer,
    recoveryCopyIssuedToPeer,
    recoveryCopyStoredByPeer,
    direction,
  }
}

/** Record that we sealed our spare for this peer (they still must import it). */
export function markSpareGivenToPeer(peerDeviceId: string, peerIdentityKey: string): void {
  const id = peerDeviceId.trim()
  const ik = peerIdentityKey.trim()
  if (!id || !isPubkey(ik)) return
  const map = readGiven()
  map[id] = { peerDeviceId: id, peerIdentityKey: ik, givenAt: Date.now(), confirmed: false }
  writeGiven(map)
}

/** The holder saw the peer store the copy (it shows "Copy stored"). */
export function confirmSpareStoredByPeer(peerDeviceId: string): void {
  const map = readGiven()
  const record = map[peerDeviceId.trim()]
  if (!record || record.confirmed !== false) return
  map[record.peerDeviceId] = { ...record, confirmed: true }
  writeGiven(map)
}

/**
 * Prove the operator before sealing or opening a copy, with whatever factor
 * this wallet actually has: typed password, device unlock, or the no-lock
 * wrap secret. Always yields the vault master key.
 */
async function proveOperator(password: string | undefined, reason: string): Promise<UnlockedVault> {
  if (password) return unlockVault(password)
  const open = isNoDeviceLock() ? getOpenUnlockSecret() : null
  if (open) return unlockVault(open)
  if (readVaultUnlockFactors().device) return unlockVaultWithDevice(reason)
  throw new Error('Enter your unlock password')
}

/** True when sealing/opening needs a typed password (no device or open factor). */
export function deviceBackupNeedsPassword(): boolean {
  if (isNoDeviceLock()) return false
  return !readVaultUnlockFactors().device
}

/**
 * The active wallet's vault master and its primary account, whose key seals
 * and opens copies (a BRC-157 entropy key never signs or encrypts).
 */
function masterOfActive(unlocked: UnlockedVault) {
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock this wallet first')
  if (!sameVaultMaster(unlocked.master, active.vaultMaster)) {
    throw new Error('Session does not match vault — unlock again')
  }
  const key = PrivateKey.fromHex(accountRootKeyHex(active.vaultMaster, 0))
  return {
    active,
    vaultMaster: active.vaultMaster,
    rootKeyHex: key.toHex(),
    identityKey: key.toPublicKey().toString(),
    address: key.toAddress(),
  }
}

export function removeDeviceKeyBackup(peerDeviceId: string): void {
  const map = readStore()
  if (peerDeviceId in map) {
    delete map[peerDeviceId]
    writeStore(map)
  }
}

/**
 * Delete the recovery copy held on this device when unlinking.
 *
 * A copy may have been duplicated after it was shown or imported, so the
 * selected direction is deliberately retained as a safety tombstone.
 * Re-linking the same device must not make the reverse direction look safe.
 */
export function clearSpareExchangeForPeer(peerDeviceId: string): void {
  if (hasDeviceKeyBackup(peerDeviceId)) markRecoveryCopyReceived(peerDeviceId)
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
  password?: string
  peerIdentityKey: string
  peerDeviceId: string
  label?: string
}): Promise<DeviceKeyBackupPackage> {
  const peerIk = args.peerIdentityKey.trim()
  const peerDeviceId = args.peerDeviceId.trim()
  if (!isPubkey(peerIk)) throw new Error('Peer identity key is invalid')
  if (!peerDeviceId) throw new Error('Peer device id is required')

  const unlocked = await proveOperator(args.password, 'Seal a recovery copy')
  const master = masterOfActive(unlocked)
  if (
    peerIk.toLowerCase() === master.identityKey.toLowerCase() ||
    peerIk.toLowerCase() === master.active.identityKey.toLowerCase()
  ) {
    throw new Error('Cannot seal a spare key to this same identity')
  }
  if (hasDeviceKeyBackup(peerDeviceId) || readReceived()[peerDeviceId]) {
    throw new Error(
      'This device already protects that peer wallet. Reciprocal device backups are refused; remove the existing backup relationship before choosing the opposite direction.',
    )
  }

  const secret: CustodySecret = {
    v: 1,
    rootKeyHex: master.vaultMaster.keyHex,
    mnemonic: unlocked.mnemonic,
    identityKey: master.identityKey,
    address: master.address,
    ...(master.vaultMaster.derivation === 'brc-157'
      ? { derivation: 'brc-157' as const, entropyLength: master.vaultMaster.entropyLength }
      : {}),
  }
  const sender = PrivateKey.fromHex(master.rootKeyHex)
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
    fromIdentityKey: master.identityKey,
    fromAddress: master.address,
    fromLabel: args.label?.trim() || 'Device',
    forIdentityKey: peerIk,
    sealedAt: Date.now(),
    ciphertextB64: Utils.toBase64(cipher),
  }
  // This relationship is intentionally one-way. Import refuses the opposite leg.
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
  if (hasSpareGivenToPeer(pkg.fromDeviceId)) {
    throw new Error(
      'That peer already holds a recovery copy of this wallet. Reciprocal device backups are refused; remove the existing backup relationship before choosing the opposite direction.',
    )
  }

  const map = readStore()
  map[pkg.fromDeviceId] = pkg
  writeStore(map)
  markRecoveryCopyReceived(pkg.fromDeviceId)
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
  password?: string
}): Promise<OpenedDeviceKeyBackup> {
  const pkg = getDeviceKeyBackup(args.peerDeviceId)
  if (!pkg) throw new Error('No sealed spare for that device')

  const unlocked = await proveOperator(args.password, 'Open a recovery copy')
  const master = masterOfActive(unlocked)
  // Copies imported on a sub-account are sealed to that account's identity.
  const forIk = pkg.forIdentityKey.toLowerCase()
  const recipientHex =
    forIk === master.active.identityKey.toLowerCase()
      ? master.active.rootKeyHex
      : forIk === master.identityKey.toLowerCase()
        ? master.rootKeyHex
        : null
  if (!recipientHex) throw new Error('Stored spare is not sealed for this identity')

  const recipient = PrivateKey.fromHex(recipientHex)
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
  let opened: VaultMaster
  try {
    opened = parseVaultMaster({
      keyHex: secret.rootKeyHex,
      derivation: secret.derivation,
      entropyLength: secret.entropyLength,
    })
  } catch {
    throw new Error('Sealed spare payload is unsupported')
  }
  if (vaultIdentityKey(opened).toLowerCase() !== secret.identityKey.toLowerCase()) {
    throw new Error('Sealed spare key does not match its identity')
  }

  return {
    package: pkg,
    rootKeyHex: secret.rootKeyHex,
    mnemonic: typeof secret.mnemonic === 'string' ? secret.mnemonic : null,
    identityKey: secret.identityKey,
    address: secret.address,
  }
}
