import { getActiveWallet, type ActiveWallet } from './session'

/**
 * Handles /handcash-device/v1/* for paired same-identity peers on the LAN.
 * Every wallet route needs a device-peer proof (devicePeerAuth.ts) and answers
 * sealed to it; without one a caller gets no identity or wallet data.
 */
import { fetchBalanceSats } from './session'
import { listFriends } from './friends'
import {
  buildPairPayload,
  enrollLocalDevice,
  getOrCreateDeviceId,
} from './deviceWallets'
import { listCollectables } from './collectables'
import { handleScanLoginRequest, isScanLoginPath } from './scanLogin/receiver'
import {
  DEVICE_PEER_AUTH_HEADER,
  DeviceAuthReplayCache,
  sealForPeer,
  verifyDeviceAuth,
} from './devicePeerAuth'

type HttpRequestEvent = {
  method: string
  path: string
  headers: Record<string, string>
  body: string
  request_id: number
}

type PeerResponse = { status: number; body: string }

const WALLET_ROUTES = new Set([
  'GET /handcash-device/v1/health',
  'GET /handcash-device/v1/snapshot',
  'GET /handcash-device/v1/pair-info',
])

const replay = new DeviceAuthReplayCache()

function authHeader(headers: Record<string, string>): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === DEVICE_PEER_AUTH_HEADER) return value
  }
  return undefined
}

function routeOf(path: string): string {
  const at = path.indexOf('/handcash-device/v1/')
  return at >= 0 ? path.slice(at) : path
}

function errorResponse(status: number, code: string, description: string): PeerResponse {
  return { status, body: JSON.stringify({ status: 'error', code, description }) }
}

export async function handleDevicePeerRequest(
  event: HttpRequestEvent,
): Promise<PeerResponse> {
  if (event.method === 'OPTIONS') {
    return { status: 200, body: '' }
  }

  const path = event.path.replace(/\/+$/, '') || '/'
  // Scan-to-login runs before any wallet exists on this device.
  if (isScanLoginPath(path)) return handleScanLoginRequest({ ...event, path })

  const route = routeOf(path)
  const method = event.method.toUpperCase()
  if (!WALLET_ROUTES.has(`${method} ${route}`)) {
    return errorResponse(404, 'NOT_FOUND', 'Unknown device-peer route')
  }

  const active = getActiveWallet()
  if (!active) {
    return errorResponse(503, 'WALLET_LOCKED', 'Unlock HandCash on this device first.')
  }
  const nonce = await verifyDeviceAuth(active.rootKeyHex, authHeader(event.headers), method, route, replay)
  if (!nonce) {
    return errorResponse(401, 'DEVICE_AUTH_REQUIRED', 'Only devices signed in to this wallet may ask.')
  }

  const answer = await answerFor(route, active)
  if ('error' in answer) return answer.error
  return {
    status: 200,
    body: JSON.stringify({ sealed: await sealForPeer(active.rootKeyHex, nonce, answer.value) }),
  }
}

async function answerFor(
  route: string,
  active: ActiveWallet,
): Promise<{ value: object } | { error: PeerResponse }> {
  const platform = window.handcash?.platform ?? 'web'

  if (route === '/handcash-device/v1/health') {
    const local = enrollLocalDevice({
      identityKey: active.identityKey,
      address: active.address,
      platform,
    })
    return {
      value: {
        ok: true,
        service: 'handcash-device-peer',
        deviceId: local.deviceId,
        identityKey: active.identityKey,
        label: local.label,
        platform: local.platform,
      },
    }
  }

  if (route === '/handcash-device/v1/snapshot') {
    const local = enrollLocalDevice({
      identityKey: active.identityKey,
      address: active.address,
      platform,
    })
    const [balanceSats, collectables] = await Promise.all([
      fetchBalanceSats(active.wallet),
      listCollectables(active),
    ])
    return {
      value: {
        identityKey: active.identityKey,
        deviceId: local.deviceId,
        label: local.label,
        platform: local.platform,
        balanceSats,
        friends: listFriends(),
        collectables: collectables.map((c) => ({
          outpoint: c.outpoint,
          origin: c.origin,
          name: c.name,
          app: c.app,
          satoshis: c.satoshis,
        })),
      },
    }
  }

  try {
    const status = await window.handcash?.getBridgeStatus?.()
    const peerBaseUrl = status?.devicePeerLanUrls?.[0] ?? null
    return {
      value: buildPairPayload({
        identityKey: active.identityKey,
        address: active.address,
        peerBaseUrl,
        platform: window.handcash?.platform,
      }),
    }
  } catch (err) {
    return { error: errorResponse(400, 'PAIR_INFO_FAILED', err instanceof Error ? err.message : String(err)) }
  }
}

export function localDeviceId(): string {
  return getOrCreateDeviceId()
}
