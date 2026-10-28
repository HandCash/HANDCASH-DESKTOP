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
  /** The microphone and camera last picked, by device id; null is the system default. */
  mic: string | null
  camera: string | null
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

function deviceId(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : null
}

export function readCallSettings(): CallSettings {
  try {
    const raw = durableGetItem(storageRegistry.callSettings.key)
    const v = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    return { relay: parseRelay(v.relay), mic: deviceId(v.mic), camera: deviceId(v.camera) }
  } catch {
    return { relay: null, mic: null, camera: null }
  }
}

/** Change some settings, keeping the rest. */
export function writeCallSettings(change: Partial<CallSettings>): void {
  const next = { ...readCallSettings(), ...change }
  const clean: CallSettings = { relay: parseRelay(next.relay), mic: deviceId(next.mic), camera: deviceId(next.camera) }
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
