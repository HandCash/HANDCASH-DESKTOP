/**
 * Handles /handcash-device/v1/* for paired same-identity peers on the LAN.
 */
import { getActiveWallet, fetchBalanceSats } from './session'
import { listFriends } from './friends'
import {
  buildPairPayload,
  enrollLocalDevice,
  getOrCreateDeviceId,
} from './deviceWallets'
import { listCollectables } from './collectables'

type HttpRequestEvent = {
  method: string
  path: string
  headers: Record<string, string>
  body: string
  request_id: number
}

function headerIdentity(headers: Record<string, string>): string | undefined {
  const raw =
    headers['x-handcash-identity'] ??
    headers['X-HandCash-Identity'] ??
    headers['x-handcash-identity'.toLowerCase()]
  return typeof raw === 'string' ? raw.trim() : undefined
}

export async function handleDevicePeerRequest(
  event: HttpRequestEvent,
): Promise<{ status: number; body: string }> {
  if (event.method === 'OPTIONS') {
    return { status: 200, body: '' }
  }

  const path = event.path.replace(/\/+$/, '') || '/'
  const active = getActiveWallet()

  if (path.endsWith('/handcash-device/v1/health') && event.method === 'GET') {
    if (!active) {
      return {
        status: 503,
        body: JSON.stringify({ ok: false, description: 'Wallet locked' }),
      }
    }
    const platform = window.handcash?.platform ?? 'web'
    const local = enrollLocalDevice({
      identityKey: active.identityKey,
      address: active.address,
      platform,
    })
    return {
      status: 200,
      body: JSON.stringify({
        ok: true,
        service: 'handcash-device-peer',
        deviceId: local.deviceId,
        identityKey: active.identityKey,
        label: local.label,
        platform: local.platform,
      }),
    }
  }

  if (path.endsWith('/handcash-device/v1/snapshot') && event.method === 'GET') {
    if (!active) {
      return {
        status: 503,
        body: JSON.stringify({
          status: 'error',
          code: 'WALLET_LOCKED',
          description: 'Unlock HandCash on this device first.',
        }),
      }
    }
    const expected = headerIdentity(event.headers)
    if (!expected || expected !== active.identityKey) {
      return {
        status: 403,
        body: JSON.stringify({
          status: 'error',
          code: 'IDENTITY_MISMATCH',
          description: 'Same HandCash identity required.',
        }),
      }
    }

    const platform = window.handcash?.platform ?? 'web'
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
      status: 200,
      body: JSON.stringify({
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
      }),
    }
  }

  if (path.endsWith('/handcash-device/v1/pair-info') && event.method === 'GET') {
    if (!active) {
      return {
        status: 503,
        body: JSON.stringify({ status: 'error', description: 'Wallet locked' }),
      }
    }
    try {
      const status = await window.handcash?.getBridgeStatus?.()
      const peerBaseUrl = status?.devicePeerLanUrls?.[0] ?? null
      const payload = buildPairPayload({
        identityKey: active.identityKey,
        address: active.address,
        peerBaseUrl,
        platform: window.handcash?.platform,
      })
      return { status: 200, body: JSON.stringify(payload) }
    } catch (err) {
      return {
        status: 400,
        body: JSON.stringify({
          status: 'error',
          code: 'PAIR_INFO_FAILED',
          description: err instanceof Error ? err.message : String(err),
        }),
      }
    }
  }

  return {
    status: 404,
    body: JSON.stringify({ status: 'error', description: 'Unknown device-peer route' }),
  }
}

export function localDeviceId(): string {
  return getOrCreateDeviceId()
}
