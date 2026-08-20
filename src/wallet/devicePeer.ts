import type { Friend } from './friends'
import {
  DEVICE_PEER_PORT,
  assertPairBackupUrlCompatible,
  getOrCreateDeviceId,
  type DevicePairPayload,
  parsePairPayload,
} from './deviceWallets'

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

export async function probeDevicePeer(
  peerBaseUrl: string,
  timeoutMs = 2500,
): Promise<DevicePeerHealth | null> {
  try {
    const res = await fetch(joinUrl(peerBaseUrl, '/handcash-device/v1/health'), {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const data = (await res.json()) as DevicePeerHealth
    if (!data?.ok || typeof data.identityKey !== 'string') return null
    return data
  } catch {
    return null
  }
}

export async function fetchDevicePeerSnapshot(
  peerBaseUrl: string,
  expectedIdentityKey: string,
  timeoutMs = 8000,
): Promise<DevicePeerSnapshot> {
  const res = await fetch(joinUrl(peerBaseUrl, '/handcash-device/v1/snapshot'), {
    method: 'GET',
    headers: {
      'X-HandCash-Identity': expectedIdentityKey,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 160)
    throw new Error(`Peer snapshot failed (${res.status})${detail ? `: ${detail}` : ''}`)
  }
  const data = (await res.json()) as DevicePeerSnapshot
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

  if (!payload.peerBaseUrl) {
    return { ...payload, online: false }
  }

  const health = await probeDevicePeer(payload.peerBaseUrl)
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
