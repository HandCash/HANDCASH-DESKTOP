/**
 * Same identity installs: roster + QR pair.
 * Linking requires the same BRC-39 backup base URL on both devices (deviceSync).
 * Optional LAN peerBaseUrl is only for live peek — not how parity syncs.
 */
import { durableGetItem, durableSetItem } from './durableStorage'
import { assertDeviceLinkBackupUrl, backupUrlsMatch } from './deviceSync'
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
  /** Optional LAN peek URL; parity sync uses backupBaseUrl, not this. */
  peerBaseUrl: string | null
  isLocal: boolean
  identityKey: string
  lastSeenAt: number | null
  online: boolean
}

export type DevicePairPayload = {
  v: 2
  identityKey: string
  deviceId: string
  label: string
  platform: string
  /** Shared History / BRC-39 base URL — required to link */
  backupBaseUrl: string
  /** Optional LAN device-peer for live peek */
  peerBaseUrl?: string | null
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

function readRoster(): DeviceWallet[] {
  try {
    const raw = durableGetItem(ROSTER_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as DeviceWallet[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (w) =>
        w &&
        typeof w.deviceId === 'string' &&
        typeof w.label === 'string' &&
        typeof w.identityKey === 'string',
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
  const local = listDeviceWallets().find((w) => w.isLocal)
  const saved = durableGetItem(SELECTED_KEY)?.trim()
  if (saved && listDeviceWallets().some((w) => w.deviceId === saved)) return saved
  return local?.deviceId ?? getOrCreateDeviceId()
}

export function getSelectedDeviceWallet(): DeviceWallet | null {
  const id = getSelectedDeviceId()
  return listDeviceWallets().find((w) => w.deviceId === id) ?? null
}

export function selectDeviceWallet(deviceId: string): void {
  if (!listDeviceWallets().some((w) => w.deviceId === deviceId)) return
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
  const roster = readRoster().filter(
    (w) => w.identityKey === args.identityKey || w.isLocal,
  )
  const withoutLocal = roster.filter((w) => !w.isLocal && w.identityKey === args.identityKey)
  const local: DeviceWallet = {
    deviceId,
    label,
    platform,
    peerBaseUrl: args.peerBaseUrl ?? null,
    isLocal: true,
    identityKey: args.identityKey,
    lastSeenAt: Date.now(),
    online: true,
  }
  writeRoster([local, ...withoutLocal.filter((w) => w.deviceId !== deviceId)])
  if (!durableGetItem(SELECTED_KEY)) {
    durableSetItem(SELECTED_KEY, deviceId)
  }
  return local
}

export function upsertPeerDevice(peer: Omit<DeviceWallet, 'isLocal' | 'online'> & {
  online?: boolean
}): DeviceWallet {
  const local = readRoster().find((w) => w.isLocal)
  if (local && peer.identityKey !== local.identityKey) {
    throw new Error('Peer identity does not match this wallet')
  }
  if (peer.deviceId === local?.deviceId) {
    throw new Error('Cannot pair this device with itself')
  }
  const entry: DeviceWallet = {
    ...peer,
    isLocal: false,
    online: peer.online ?? false,
    lastSeenAt: peer.lastSeenAt ?? Date.now(),
  }
  const rest = readRoster().filter((w) => w.deviceId !== entry.deviceId)
  writeRoster([...rest, entry])
  return entry
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
  patch: Partial<Pick<DeviceWallet, 'online' | 'lastSeenAt' | 'peerBaseUrl' | 'label'>>,
): void {
  const roster = readRoster()
  const idx = roster.findIndex((w) => w.deviceId === deviceId)
  if (idx < 0) return
  roster[idx] = { ...roster[idx]!, ...patch }
  writeRoster(roster)
}

export function buildPairPayload(args: {
  identityKey: string
  backupBaseUrl?: string
  peerBaseUrl?: string | null
  label?: string
  platform?: string
}): DevicePairPayload {
  const platform =
    args.platform ?? window.handcash?.platform ?? 'web'
  const backupBaseUrl = normalizePairBackupUrl(
    args.backupBaseUrl ?? assertDeviceLinkBackupUrl(),
  )
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
    backupBaseUrl,
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
  if (o.v !== 2 && o.v !== 1) throw new Error('Unsupported pair payload version')
  if (typeof o.identityKey !== 'string' || !/^(02|03)[0-9a-fA-F]{64}$/.test(o.identityKey)) {
    throw new Error('Pair payload identity key is invalid')
  }
  if (typeof o.deviceId !== 'string' || !o.deviceId.trim()) {
    throw new Error('Pair payload missing deviceId')
  }

  let backupBaseUrl: string
  if (typeof o.backupBaseUrl === 'string' && o.backupBaseUrl.trim()) {
    backupBaseUrl = normalizePairBackupUrl(o.backupBaseUrl)
  } else if (o.v === 1) {
    throw new Error('This pair code is outdated — both devices need a History backup URL')
  } else {
    throw new Error('Pair payload missing backup URL')
  }

  const peerBaseUrl =
    typeof o.peerBaseUrl === 'string' && /^https?:\/\//i.test(o.peerBaseUrl)
      ? o.peerBaseUrl.replace(/\/+$/, '')
      : null

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

export function pairPayloadToQrText(payload: DevicePairPayload): string {
  return JSON.stringify(payload)
}

/** Local backup URL must match the peer’s before linking. */
export function assertPairBackupUrlCompatible(peerBackupBaseUrl: string): void {
  const local = resolveHistoryBackupBaseUrl()
  if (!local) {
    throw new Error('Set your History backup URL first (same URL on both devices)')
  }
  if (!backupUrlsMatch(local, peerBackupBaseUrl)) {
    throw new Error('Backup URLs do not match — both devices must use the same History URL')
  }
}
