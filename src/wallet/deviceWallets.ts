/**
 * Known devices roster + device code QR.
 *
 * Different identity keys are never linked as one identity. Their device id
 * and public key may be retained only to establish one-way sealed recovery.
 * History URL sync remains optional for same-identity installs only.
 */
import { durableGetItem, durableSetItem } from './durableStorage'
import { backupUrlsMatch } from './deviceSync'
import { resolveHistoryBackupBaseUrl } from './historyBackupPrefs'

const DEVICE_ID_KEY = 'handcash.brc100.deviceId.v1'
const ROSTER_KEY = 'handcash.brc100.deviceWallets.v1'
const SELECTED_KEY = 'handcash.brc100.selectedDeviceWallet.v1'

/** Dedicated LAN peer port — BRC-100 app bridge stays on loopback :3321. */
export const DEVICE_PEER_PORT = 3340

export type DeviceWallet = {
  deviceId: string
  label: string
  platform: string
  /** Optional LAN peek URL; same-identity installs only. */
  peerBaseUrl: string | null
  isLocal: boolean
  identityKey: string
  /** Receive / identity address when known (pair v3). */
  address: string | null
  lastSeenAt: number | null
  online: boolean
  /** When this peer relationship was added on this install. */
  linkedAt: number | null
  /**
   * `backup-only` means identities differ. The public key and device id are
   * retained solely for directional sealed recovery; there is no identity,
   * balance, history, or spend link.
   */
  linkMode: 'linked' | 'backup-only'
}

/** Legacy same-identity + History URL pair. */
export type DevicePairPayloadV2 = {
  v: 2
  identityKey: string
  deviceId: string
  label: string
  platform: string
  backupBaseUrl: string
  peerBaseUrl?: string | null
}

/** Backup-link discovery payload. No identity claim is established by scanning it. */
export type DevicePairPayloadV3 = {
  v: 3
  identityKey: string
  address: string
  deviceId: string
  label: string
  platform: string
  peerBaseUrl?: string | null
}

export type DevicePairPayload = DevicePairPayloadV2 | DevicePairPayloadV3

export type PairAcceptancePath =
  | { path: 'same-identity' }
  | { path: 'backup-only'; reason: 'cross-identity' }
  | { path: 'refuse'; reason: 'same-device' }

/**
 * Decide what a scanned pair QR is allowed to establish.
 *
 * Matching keys may use the existing same-wallet device path. Different keys
 * are retained only as recovery peers; scanning never claims that they are one
 * identity.
 */
export function choosePairAcceptancePath(
  payload: DevicePairPayload,
  localIdentityKey: string,
  localDeviceId = getOrCreateDeviceId(),
): PairAcceptancePath {
  if (payload.deviceId === localDeviceId) {
    return { path: 'refuse', reason: 'same-device' }
  }
  if (payload.identityKey.toLowerCase() !== localIdentityKey.toLowerCase()) {
    return { path: 'backup-only', reason: 'cross-identity' }
  }
  return { path: 'same-identity' }
}

type RosterListener = (wallets: DeviceWallet[]) => void
type SelectionListener = (deviceId: string) => void

const rosterListeners = new Set<RosterListener>()
const selectionListeners = new Set<SelectionListener>()

function notifyRoster() {
  const list = listDeviceWallets()
  for (const l of rosterListeners) l(list)
}

function notifySelection(deviceId: string) {
  for (const l of selectionListeners) l(deviceId)
}

export function getOrCreateDeviceId(): string {
  const existing = durableGetItem(DEVICE_ID_KEY)?.trim()
  if (existing) return existing
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `dev-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`
  durableSetItem(DEVICE_ID_KEY, id)
  return id
}

function defaultLabel(platform: string): string {
  if (platform === 'darwin') return 'This Mac'
  if (platform === 'win32') return 'This Windows PC'
  if (platform === 'linux') return 'This Linux PC'
  if (platform === 'android') return 'This phone'
  if (platform === 'ios') return 'This iPhone'
  return 'This device'
}

function normalizeWallet(raw: Partial<DeviceWallet> & {
  deviceId: string
  label: string
  identityKey: string
}): DeviceWallet {
  return {
    deviceId: raw.deviceId,
    label: raw.label,
    platform: typeof raw.platform === 'string' ? raw.platform : 'unknown',
    peerBaseUrl: typeof raw.peerBaseUrl === 'string' ? raw.peerBaseUrl : null,
    isLocal: Boolean(raw.isLocal),
    identityKey: raw.identityKey,
    address: typeof raw.address === 'string' && raw.address.trim() ? raw.address.trim() : null,
    lastSeenAt: typeof raw.lastSeenAt === 'number' ? raw.lastSeenAt : null,
    online: Boolean(raw.online),
    linkedAt: typeof raw.linkedAt === 'number' ? raw.linkedAt : null,
    linkMode: raw.linkMode === 'backup-only' ? 'backup-only' : 'linked',
  }
}

function readRoster(): DeviceWallet[] {
  try {
    const raw = durableGetItem(ROSTER_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (w): w is Record<string, unknown> =>
          Boolean(w) &&
          typeof w === 'object' &&
          typeof (w as DeviceWallet).deviceId === 'string' &&
          typeof (w as DeviceWallet).label === 'string' &&
          typeof (w as DeviceWallet).identityKey === 'string',
      )
      .map((w) =>
        normalizeWallet({
          deviceId: w.deviceId as string,
          label: w.label as string,
          identityKey: w.identityKey as string,
          platform: w.platform as string | undefined,
          peerBaseUrl: w.peerBaseUrl as string | null | undefined,
          isLocal: w.isLocal as boolean | undefined,
          address: w.address as string | null | undefined,
          lastSeenAt: w.lastSeenAt as number | null | undefined,
          online: w.online as boolean | undefined,
          linkedAt: w.linkedAt as number | null | undefined,
          linkMode: w.linkMode as DeviceWallet['linkMode'] | undefined,
        }),
      )
  } catch {
    return []
  }
}

function writeRoster(wallets: DeviceWallet[]) {
  durableSetItem(ROSTER_KEY, JSON.stringify(wallets))
  notifyRoster()
}

export function listDeviceWallets(): DeviceWallet[] {
  return readRoster().slice().sort((a, b) => {
    if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1
    return a.label.localeCompare(b.label)
  })
}

export function getSelectedDeviceId(): string {
  const wallets = listDeviceWallets()
  const local = wallets.find((w) => w.isLocal)
  const saved = durableGetItem(SELECTED_KEY)?.trim()
  if (
    saved &&
    wallets.some((w) => w.deviceId === saved && (w.isLocal || w.linkMode === 'linked'))
  ) {
    return saved
  }
  return local?.deviceId ?? getOrCreateDeviceId()
}

export function getSelectedDeviceWallet(): DeviceWallet | null {
  const id = getSelectedDeviceId()
  return listDeviceWallets().find((w) => w.deviceId === id) ?? null
}

export function selectDeviceWallet(deviceId: string): void {
  if (
    !listDeviceWallets().some(
      (w) => w.deviceId === deviceId && (w.isLocal || w.linkMode === 'linked'),
    )
  ) {
    return
  }
  durableSetItem(SELECTED_KEY, deviceId)
  notifySelection(deviceId)
  notifyRoster()
}

export function subscribeDeviceWallets(listener: RosterListener): () => void {
  rosterListeners.add(listener)
  listener(listDeviceWallets())
  return () => {
    rosterListeners.delete(listener)
  }
}

export function subscribeSelectedDevice(listener: SelectionListener): () => void {
  selectionListeners.add(listener)
  listener(getSelectedDeviceId())
  return () => {
    selectionListeners.delete(listener)
  }
}

/** Ensure this install is on the roster for the unlocked identity. */
export function enrollLocalDevice(args: {
  identityKey: string
  address?: string | null
  platform?: string
  peerBaseUrl?: string | null
  label?: string
}): DeviceWallet {
  const deviceId = getOrCreateDeviceId()
  const platform =
    args.platform ??
    window.handcash?.platform ??
    (typeof navigator !== 'undefined' ? navigator.platform : 'web')
  const label = args.label?.trim() || defaultLabel(platform)
  const previous = readRoster()
  const peers = previous
    .filter((w) => !w.isLocal && w.deviceId !== deviceId)
    .map((w) =>
      w.identityKey.toLowerCase() === args.identityKey.toLowerCase()
        ? w
        : {
            ...w,
            peerBaseUrl: null,
            online: false,
            linkMode: 'backup-only' as const,
          },
    )
  const local: DeviceWallet = {
    deviceId,
    label,
    platform,
    peerBaseUrl: args.peerBaseUrl ?? null,
    isLocal: true,
    identityKey: args.identityKey,
    address: args.address?.trim() || null,
    lastSeenAt: Date.now(),
    online: true,
    linkedAt: null,
    linkMode: 'linked',
  }
  writeRoster([local, ...peers])
  if (!durableGetItem(SELECTED_KEY)) {
    durableSetItem(SELECTED_KEY, deviceId)
  }
  return local
}

export function upsertPeerDevice(
  peer: Omit<
    DeviceWallet,
    'isLocal' | 'online' | 'linkedAt' | 'address' | 'linkMode'
  > & {
    online?: boolean
    linkedAt?: number | null
    address?: string | null
    linkMode?: DeviceWallet['linkMode']
  },
): DeviceWallet {
  const local = readRoster().find((w) => w.isLocal)
  if (peer.deviceId === local?.deviceId) {
    throw new Error('Cannot pair this device with itself')
  }
  const sameIdentity =
    local?.identityKey.toLowerCase() === peer.identityKey.toLowerCase()
  const entry: DeviceWallet = {
    deviceId: peer.deviceId,
    label: peer.label,
    platform: peer.platform,
    peerBaseUrl: sameIdentity ? (peer.peerBaseUrl ?? null) : null,
    isLocal: false,
    identityKey: peer.identityKey,
    address: peer.address?.trim() || null,
    lastSeenAt: peer.lastSeenAt ?? Date.now(),
    online: sameIdentity ? (peer.online ?? false) : false,
    linkedAt: peer.linkedAt ?? Date.now(),
    linkMode: sameIdentity ? 'linked' : 'backup-only',
  }
  const rest = readRoster().filter((w) => w.deviceId !== entry.deviceId)
  writeRoster([...rest, entry])
  return entry
}

/**
 * Make an imported sealed spare reachable from the recovery UI.
 */
export function upsertPeerFromSealedBackup(pkg: {
  fromDeviceId: string
  fromIdentityKey: string
  fromAddress: string
  fromLabel: string
}): DeviceWallet {
  return upsertPeerDevice({
    deviceId: pkg.fromDeviceId,
    label: pkg.fromLabel,
    platform: 'unknown',
    peerBaseUrl: null,
    identityKey: pkg.fromIdentityKey,
    address: pkg.fromAddress,
    lastSeenAt: Date.now(),
    online: false,
    linkMode: 'backup-only',
  })
}

export function removePeerDevice(deviceId: string): void {
  const next = readRoster().filter((w) => !(w.deviceId === deviceId && !w.isLocal))
  writeRoster(next)
  if (getSelectedDeviceId() === deviceId) {
    const local = next.find((w) => w.isLocal)
    if (local) selectDeviceWallet(local.deviceId)
  }
}

export function patchDeviceWallet(
  deviceId: string,
  patch: Partial<
    Pick<DeviceWallet, 'online' | 'lastSeenAt' | 'peerBaseUrl' | 'label' | 'address'>
  >,
): void {
  const roster = readRoster()
  const idx = roster.findIndex((w) => w.deviceId === deviceId)
  if (idx < 0) return
  roster[idx] = { ...roster[idx]!, ...patch }
  writeRoster(roster)
}

/** Build a v3 device code discovery QR (preferred). */
export function buildPairPayload(args: {
  identityKey: string
  address: string
  peerBaseUrl?: string | null
  label?: string
  platform?: string
}): DevicePairPayloadV3 {
  const platform = args.platform ?? window.handcash?.platform ?? 'web'
  const peer =
    typeof args.peerBaseUrl === 'string' && args.peerBaseUrl.trim()
      ? args.peerBaseUrl.replace(/\/+$/, '')
      : null
  const address = args.address.trim()
  if (!address) throw new Error('Pair payload missing address')
  return {
    v: 3,
    identityKey: args.identityKey.trim(),
    address,
    deviceId: getOrCreateDeviceId(),
    label: args.label?.trim() || defaultLabel(platform),
    platform,
    peerBaseUrl: peer,
  }
}

/** @deprecated Legacy History-URL pair — kept for old QR codes. */
export function buildLegacyPairPayload(args: {
  identityKey: string
  backupBaseUrl: string
  peerBaseUrl?: string | null
  label?: string
  platform?: string
}): DevicePairPayloadV2 {
  const platform = args.platform ?? window.handcash?.platform ?? 'web'
  const peer =
    typeof args.peerBaseUrl === 'string' && args.peerBaseUrl.trim()
      ? args.peerBaseUrl.replace(/\/+$/, '')
      : null
  return {
    v: 2,
    identityKey: args.identityKey.trim(),
    deviceId: getOrCreateDeviceId(),
    label: args.label?.trim() || defaultLabel(platform),
    platform,
    backupBaseUrl: normalizePairBackupUrl(args.backupBaseUrl),
    peerBaseUrl: peer,
  }
}

function normalizePairBackupUrl(raw: string): string {
  const base = raw.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) {
    throw new Error('Backup URL must be http(s)')
  }
  return base
}

function isPubkey(s: string): boolean {
  return /^(02|03)[0-9a-fA-F]{64}$/.test(s)
}

export function parsePairPayload(raw: string): DevicePairPayload {
  const text = raw.trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Pair code must be a HandCash device QR JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid pair payload')
  }
  const o = parsed as Record<string, unknown>
  if (o.v !== 3 && o.v !== 2 && o.v !== 1) throw new Error('Unsupported pair payload version')
  if (typeof o.identityKey !== 'string' || !isPubkey(o.identityKey)) {
    throw new Error('Pair payload identity key is invalid')
  }
  if (typeof o.deviceId !== 'string' || !o.deviceId.trim()) {
    throw new Error('Pair payload missing deviceId')
  }

  const peerBaseUrl =
    typeof o.peerBaseUrl === 'string' && /^https?:\/\//i.test(o.peerBaseUrl)
      ? o.peerBaseUrl.replace(/\/+$/, '')
      : null

  if (o.v === 3) {
    if (typeof o.address !== 'string' || !o.address.trim()) {
      throw new Error('Pair payload missing address')
    }
    return {
      v: 3,
      identityKey: o.identityKey,
      address: o.address.trim(),
      deviceId: o.deviceId.trim(),
      label: typeof o.label === 'string' && o.label.trim() ? o.label.trim() : 'Device',
      platform: typeof o.platform === 'string' ? o.platform : 'unknown',
      peerBaseUrl,
    }
  }

  let backupBaseUrl: string
  if (typeof o.backupBaseUrl === 'string' && o.backupBaseUrl.trim()) {
    backupBaseUrl = normalizePairBackupUrl(o.backupBaseUrl)
  } else if (o.v === 1) {
    throw new Error(
      'That device code is outdated — ask the other device to show a fresh code',
    )
  } else {
    throw new Error('Pair payload missing backup URL')
  }

  return {
    v: 2,
    identityKey: o.identityKey,
    deviceId: o.deviceId.trim(),
    label: typeof o.label === 'string' && o.label.trim() ? o.label.trim() : 'Device',
    platform: typeof o.platform === 'string' ? o.platform : 'unknown',
    backupBaseUrl,
    peerBaseUrl,
  }
}

/** True when raw QR text looks like a device code payload (cheap, non-throwing). */
export function tryParsePairPayload(raw: string): DevicePairPayload | null {
  const text = raw.trim()
  if (!text.startsWith('{') || !text.includes('"identityKey"')) return null
  if (text.includes('handcash-device-key-backup')) return null
  try {
    return parsePairPayload(text)
  } catch {
    return null
  }
}

export function pairPayloadToQrText(payload: DevicePairPayload): string {
  return JSON.stringify(payload)
}

/** Legacy: local History URL must match the peer’s before v2 linking. */
export function assertPairBackupUrlCompatible(peerBackupBaseUrl: string): void {
  const local = resolveHistoryBackupBaseUrl()
  if (!local) {
    throw new Error('Set your History backup URL first (same URL on both devices)')
  }
  if (!backupUrlsMatch(local, peerBackupBaseUrl)) {
    throw new Error('Backup URLs do not match — both devices must use the same History URL')
  }
}

export function isSameIdentityPeer(peer: DeviceWallet, localIdentityKey: string): boolean {
  return peer.identityKey.toLowerCase() === localIdentityKey.toLowerCase()
}
