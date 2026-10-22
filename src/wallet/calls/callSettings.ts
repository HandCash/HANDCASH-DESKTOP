import { storageRegistry } from '../../storage/registry'
import { durableGetItem, durableSetItem } from '../durableStorage'

/**
 * Call settings on this device. Calls reach the other side straight over
 * WebRTC with public STUN; a TURN relay is only needed when both sides sit
 * behind strict NATs, and is the user's to add (it relays ciphertext only).
 */
export type CallRelay = { urls: string[]; username?: string; credential?: string }

export type CallSettings = {
  relay: CallRelay | null
}

const STUN: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }]

const listeners = new Set<(s: CallSettings) => void>()

function parseRelay(v: unknown): CallRelay | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  const urls = Array.isArray(r.urls) ? r.urls.filter((u): u is string => typeof u === 'string' && /^turns?:/i.test(u.trim())) : []
  if (urls.length === 0) return null
  return {
    urls: urls.map((u) => u.trim()),
    ...(typeof r.username === 'string' && r.username ? { username: r.username } : {}),
    ...(typeof r.credential === 'string' && r.credential ? { credential: r.credential } : {}),
  }
}

export function readCallSettings(): CallSettings {
  try {
    const raw = durableGetItem(storageRegistry.callSettings.key)
    const v = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    return { relay: parseRelay(v.relay) }
  } catch {
    return { relay: null }
  }
}

export function writeCallSettings(next: CallSettings): void {
  const clean: CallSettings = { relay: parseRelay(next.relay) }
  durableSetItem(storageRegistry.callSettings.key, JSON.stringify(clean))
  for (const listener of listeners) listener(clean)
}

export function subscribeCallSettings(listener: (s: CallSettings) => void): () => void {
  listeners.add(listener)
  listener(readCallSettings())
  return () => {
    listeners.delete(listener)
  }
}

/** `turn:` / `turns:` URLs from free text (comma, space or line separated). */
export function parseRelayUrls(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter((u) => /^turns?:\S+$/i.test(u))
}

export function callIceServers(settings: CallSettings = readCallSettings()): RTCIceServer[] {
  const relay = settings.relay
  return relay ? [...STUN, { urls: relay.urls, username: relay.username, credential: relay.credential }] : [...STUN]
}
