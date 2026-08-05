/**
 * BRC-169 cloud handle claim — separate from balance migration.
 * Hosts: same allowlist as migration (handcash.io / market / preprod / localhost).
 */
import { durableGetItem, durableSetItem } from './durableStorage'
import { getActiveWallet } from './session'
import { claimHandle } from './handleResolve'
import { isMigrationOrigin } from './migration'

const STORAGE_KEY = 'handcash.brc169.claimedHandle.v1'

export type ClaimedHandleState = {
  handle: string
  display: string
  identityKey: string
  claimedAt: number
}

export function isHandleClaimMethod(method: string): boolean {
  return method === 'claimCloudHandle' || method === 'getClaimedCloudHandle'
}

export function isHandleClaimOrigin(origin: string | undefined): boolean {
  return isMigrationOrigin(origin)
}

function normalizeCloudHandle(raw: string): string {
  const h = raw.trim().replace(/^\$/, '').replace(/^@/, '').toLowerCase()
  if (!/^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/.test(h)) {
    throw new Error('Invalid handle')
  }
  return h
}

export function readClaimedCloudHandle(): ClaimedHandleState | null {
  try {
    const raw = durableGetItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ClaimedHandleState>
    if (
      typeof parsed.handle !== 'string' ||
      typeof parsed.display !== 'string' ||
      typeof parsed.identityKey !== 'string' ||
      typeof parsed.claimedAt !== 'number'
    ) {
      return null
    }
    return {
      handle: parsed.handle,
      display: parsed.display,
      identityKey: parsed.identityKey.toLowerCase(),
      claimedAt: parsed.claimedAt,
    }
  } catch {
    return null
  }
}

export function getClaimedCloudHandlePayload(): ClaimedHandleState | null {
  return readClaimedCloudHandle()
}

let claimInFlight: Promise<ClaimedHandleState> | null = null

export async function claimCloudHandlePayload(args: {
  handle: string
}): Promise<ClaimedHandleState> {
  if (claimInFlight) return claimInFlight
  claimInFlight = (async () => {
    const active = getActiveWallet()
    if (!active) throw new Error('Wallet locked')

    const handle = normalizeCloudHandle(args.handle)
    const result = await claimHandle({
      handle,
      identityKey: active.identityKey,
    })

    const state: ClaimedHandleState = {
      handle,
      display: result.display,
      identityKey: active.identityKey.toLowerCase(),
      claimedAt: Date.now(),
    }
    durableSetItem(STORAGE_KEY, JSON.stringify(state))
    return state
  })().finally(() => {
    claimInFlight = null
  })
  return claimInFlight
}