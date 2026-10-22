import type { Friend } from './friends'
import {
  DEVICE_PEER_PORT,
  assertPairBackupUrlCompatible,
  getOrCreateDeviceId,
  type DevicePairPayload,
  parsePairPayload,
} from './deviceWallets'
import { DEVICE_PEER_AUTH_HEADER, createDeviceAuth, openFromPeer } from './devicePeerAuth'

export type DevicePeerHealth = {
  ok: boolean
  service: string
  deviceId: string
  identityKey: string
  label: string
  platform: string
}

export type DevicePeerSnapshot = {
  identityKey: string
  deviceId: string
  label: string
  platform: string
  balanceSats: number
  friends: Friend[]
  collectables: Array<{
    outpoint: string
    origin: string
    name: string
    app?: string
    satoshis: number
  }>
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`
}

/** GET a device-peer wallet route with a proof, and open the sealed answer. */
async function getSealed<T>(
  peerBaseUrl: string,
  route: string,
  rootKeyHex: string,
  timeoutMs: number,
): Promise<T> {
  const { header, nonce } = await createDeviceAuth(rootKeyHex, 'GET', route)
  const res = await fetch(joinUrl(peerBaseUrl, route), {
    method: 'GET',
    headers: { [DEVICE_PEER_AUTH_HEADER]: header, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 160)
    throw new Error(`Peer ${route} failed (${res.status})${detail ? `: ${detail}` : ''}`)
  }
  const { sealed } = (await res.json()) as { sealed?: unknown }
  if (typeof sealed !== 'string') throw new Error(`Peer ${route} answered unsealed`)
  return openFromPeer<T>(rootKeyHex, nonce, sealed)
}

export async function probeDevicePeer(
  peerBaseUrl: string,
  rootKeyHex: string,
  timeoutMs = 2500,
): Promise<DevicePeerHealth | null> {
  try {
    const data = await getSealed<DevicePeerHealth>(peerBaseUrl, '/handcash-device/v1/health', rootKeyHex, timeoutMs)
    if (!data?.ok || typeof data.identityKey !== 'string') return null
    return data
  } catch {
    return null
  }
}

export async function fetchDevicePeerSnapshot(
  peerBaseUrl: string,
  expectedIdentityKey: string,
  rootKeyHex: string,
  timeoutMs = 8000,
): Promise<DevicePeerSnapshot> {
  const data = await getSealed<DevicePeerSnapshot>(peerBaseUrl, '/handcash-device/v1/snapshot', rootKeyHex, timeoutMs)
  if (data.identityKey !== expectedIdentityKey) {
    throw new Error('Peer identity mismatch on snapshot')
  }
  return data
}

/**
 * Verify pair QR and enrich with optional LAN health.
 * This is only for same-identity devices. Different identities use the
 * recovery-only path and never enter LAN/history synchronization.
 */
export async function verifyAndEnrichPair(
  raw: string,
  localIdentityKey: string,
  localRootKeyHex?: string,
): Promise<DevicePairPayload & { online: boolean; address?: string }> {
  const payload = parsePairPayload(raw)
  if (payload.deviceId === getOrCreateDeviceId()) {
    throw new Error('Cannot pair this device with itself')
  }
  if (payload.identityKey !== localIdentityKey) {
    throw new Error(
      'Those are two different wallets; use the one-way backup flow instead',
    )
  }

  if (payload.v === 2) {
    assertPairBackupUrlCompatible(payload.backupBaseUrl)
  }

  if (!payload.peerBaseUrl || !localRootKeyHex) {
    return { ...payload, online: false }
  }

  const health = await probeDevicePeer(payload.peerBaseUrl, localRootKeyHex)
  if (!health) {
    return { ...payload, online: false }
  }
  if (health.identityKey !== payload.identityKey) {
    throw new Error('Peer identity does not match pair code')
  }
  if (health.deviceId !== payload.deviceId) {
    throw new Error('Peer device id does not match pair code')
  }
  return {
    ...payload,
    label: health.label || payload.label,
    platform: health.platform || payload.platform,
    online: true,
  }
}

export function devicePeerPort(): number {
  return DEVICE_PEER_PORT
}
