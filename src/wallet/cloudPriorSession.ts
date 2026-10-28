/**
 * Prior cloud HandCash login on this device.
 *
 * When an upgrade keeps login context (Mobile install-over; Desktop when a
 * session was written), onboarding shows a single Migrate CTA instead of
 * Sign in + Create. Desktop has no OS cloud cookie yet — only a durable
 * record (and an explicit remember from /migrate). Mobile: TODO read the
 * kept Capacitor / SharedPreferences session when that shell lands it here.
 */

import { storageRegistry } from '../storage/registry'
import { durableGetItem, durableRemoveItem, durableSetItem } from './durableStorage.js'

const KEY = storageRegistry.cloudPriorSession.key

export type CloudPriorSession = {
  /** Cloud handle without `$`, when known. */
  handle: string | null
  /** How we learned the session is present. */
  source: 'upgrade' | 'migrate' | 'remembered'
  rememberedAt: number
}

const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function parse(raw: string | null): CloudPriorSession | null {
  if (!raw) return null
  try {
    const body = JSON.parse(raw) as Partial<CloudPriorSession>
    if (!body || typeof body !== 'object') return null
    const source = body.source
    if (source !== 'upgrade' && source !== 'migrate' && source !== 'remembered') return null
    const handle =
      typeof body.handle === 'string' && body.handle.trim()
        ? body.handle.trim().replace(/^\$/, '').toLowerCase()
        : null
    const rememberedAt =
      typeof body.rememberedAt === 'number' && Number.isFinite(body.rememberedAt)
        ? body.rememberedAt
        : Date.now()
    return { handle, source, rememberedAt }
  } catch {
    return null
  }
}

/** Current prior cloud session, or null when the user must Sign in. */
export function readCloudPriorSession(): CloudPriorSession | null {
  return parse(durableGetItem(KEY))
}

/**
 * Record that this device still has a cloud HandCash login.
 * Call from upgrade detection (TODO Mobile) or after /migrate signs in.
 */
export function rememberCloudPriorSession(args: {
  handle?: string | null
  source: CloudPriorSession['source']
}): CloudPriorSession {
  const next: CloudPriorSession = {
    handle:
      typeof args.handle === 'string' && args.handle.trim()
        ? args.handle.trim().replace(/^\$/, '').toLowerCase()
        : null,
    source: args.source,
    rememberedAt: Date.now(),
  }
  durableSetItem(KEY, JSON.stringify(next))
  emit()
  return next
}

/** Clear after a successful migrate, or if the user abandons the cloud account. */
export function clearCloudPriorSession(): void {
  durableRemoveItem(KEY)
  emit()
}

export function subscribeCloudPriorSession(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Platform probe for an upgrade that kept cloud login without our durable flag.
 * Desktop/native shell: none yet (returns null).
 * Mobile: TODO read kept login prefs when the shell exposes them.
 */
export function detectUpgradeCloudSession(): CloudPriorSession | null {
  // TODO(mobile): Capacitor / SharedPreferences / Keychain cloud auth token → remember as source:'upgrade'
  return readCloudPriorSession()
}

/** Shape used by AuthScreen / authModes entry chooser. */
export type PriorLoginContext =
  | { status: 'none' }
  | { status: 'signed-in'; handle?: string }

export function priorLoginContextFromSession(
  session: CloudPriorSession | null = detectUpgradeCloudSession(),
): PriorLoginContext {
  if (!session) return { status: 'none' }
  return session.handle
    ? { status: 'signed-in', handle: session.handle }
    : { status: 'signed-in' }
}
