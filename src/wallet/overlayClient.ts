/**
 * BRC-24 / BRC-88 overlay client — host discovery + lookup with failover.
 * Prefer SLAP-advertised hosts; fall back to manifest curator hints.
 */

import type { IndexExpansionManifest } from './indexExpansionTypes'

/** BSVA mainnet SLAP trackers (@bsv/sdk LookupResolver defaults). */
export const DEFAULT_SLAP_TRACKERS = [
  'https://overlay-us-1.bsvb.tech',
  'https://overlay-eu-1.bsvb.tech',
  'https://overlay-ap-1.bsvb.tech',
  'https://users.bapp.dev',
] as const

export type OverlayDiscoveryMode = 'auto' | 'slap' | 'url'

export type OverlayLookupRequest = {
  lookupService: string
  query?: Record<string, unknown>
  /** Curator URL hint — tried before SLAP when mode is auto. */
  overlayBaseUrl?: string
  discovery?: OverlayDiscoveryMode
  slapTrackers?: string[]
  extraHosts?: string[]
}

export type RawLookupAnswer = {
  type?: string
  outputs?: unknown[]
  cursor?: unknown
}

function normalizeHost(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetchImpl(url, init)
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    json = null
  }
  return { ok: res.ok, status: res.status, json }
}

/** GET /listLookupServiceProviders — host advertises this ls_* service. */
export async function hostProvidesLookupService(
  host: string,
  lookupService: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const { ok, json } = await fetchJson(
      fetchImpl,
      `${normalizeHost(host)}/listLookupServiceProviders`,
    )
    if (!ok || !Array.isArray(json)) return false
    return json.some((s) => s === lookupService)
  } catch {
    return false
  }
}

/** POST BRC-24 /lookup on one host. */
export async function postOverlayLookup(
  host: string,
  lookupService: string,
  query: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<RawLookupAnswer> {
  const { ok, status, json } = await fetchJson(
    fetchImpl,
    `${normalizeHost(host)}/lookup`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ service: lookupService, query }),
    },
  )
  if (!ok) {
    throw new Error(`Overlay lookup failed (${status}) at ${host}`)
  }
  return (json ?? {}) as RawLookupAnswer
}

function hostFromSlapOutput(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const ctx = (raw as { context?: unknown }).context
  if (typeof ctx === 'string' && /^https?:\/\//.test(ctx.trim())) {
    return normalizeHost(ctx.trim())
  }
  if (Array.isArray(ctx) || ctx instanceof Uint8Array) {
    const bytes = ctx instanceof Uint8Array ? ctx : Uint8Array.from(ctx)
    try {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim()
      if (/^https?:\/\//.test(text)) return normalizeHost(text)
      const parsed = JSON.parse(text) as { domain?: string; host?: string; url?: string }
      const hint = parsed.domain || parsed.host || parsed.url
      if (typeof hint === 'string' && hint.trim()) {
        const withScheme = hint.startsWith('http') ? hint : `https://${hint}`
        return normalizeHost(withScheme)
      }
    } catch {
      return null
    }
  }
  return null
}

/** Query SLAP trackers for competent hosts (BRC-88 / ls_slap). */
export async function discoverSlapHosts(
  lookupService: string,
  fetchImpl: typeof fetch = fetch,
  slapTrackers: readonly string[] = DEFAULT_SLAP_TRACKERS,
): Promise<string[]> {
  const hosts = new Set<string>()
  await Promise.all(
    slapTrackers.map(async (tracker) => {
      try {
        const answer = await postOverlayLookup(
          tracker,
          'ls_slap',
          { service: lookupService },
          fetchImpl,
        )
        if (!Array.isArray(answer.outputs)) return
        for (const raw of answer.outputs) {
          const host = hostFromSlapOutput(raw)
          if (host) hosts.add(host)
        }
      } catch {
        // try next tracker
      }
    }),
  )
  return [...hosts]
}

export async function resolveOverlayLookupHosts(
  req: OverlayLookupRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const mode = req.discovery ?? 'auto'
  const lookupService = req.lookupService
  const candidates: string[] = []

  if (req.overlayBaseUrl) candidates.push(normalizeHost(req.overlayBaseUrl))
  if (Array.isArray(req.extraHosts)) {
    for (const h of req.extraHosts) {
      if (typeof h === 'string' && h.trim()) candidates.push(normalizeHost(h))
    }
  }

  if (mode === 'slap' || mode === 'auto') {
    const trackers = req.slapTrackers?.length ? req.slapTrackers : [...DEFAULT_SLAP_TRACKERS]
    const slapHosts = await discoverSlapHosts(lookupService, fetchImpl, trackers)
    candidates.push(...slapHosts)
  }

  const seen = new Set<string>()
  const ordered: string[] = []
  for (const host of candidates) {
    if (!host || seen.has(host)) continue
    seen.add(host)
    ordered.push(host)
  }

  if (mode === 'url' && ordered.length === 0 && req.overlayBaseUrl) {
    ordered.push(normalizeHost(req.overlayBaseUrl))
  }

  const verified: string[] = []
  await Promise.all(
    ordered.map(async (host) => {
      if (await hostProvidesLookupService(host, lookupService, fetchImpl)) {
        verified.push(host)
      }
    }),
  )

  if (verified.length > 0) {
    return verified
  }

  return ordered
}

export async function queryOverlayWithFailover(
  req: OverlayLookupRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<{ answer: RawLookupAnswer; host: string; hostsTried: string[] }> {
  const hosts = await resolveOverlayLookupHosts(req, fetchImpl)
  if (hosts.length === 0) {
    throw new Error(`No overlay hosts found for ${req.lookupService}`)
  }
  const query = req.query ?? {}
  const errors: string[] = []
  for (const host of hosts) {
    try {
      const answer = await postOverlayLookup(host, req.lookupService, query, fetchImpl)
      if (answer.type && answer.type !== 'output-list') {
        throw new Error(`Unexpected lookup answer type: ${answer.type}`)
      }
      return { answer, host, hostsTried: [...hosts] }
    } catch (err) {
      errors.push(`${host}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new Error(
    `All overlay hosts failed for ${req.lookupService}: ${errors.slice(0, 3).join('; ')}`,
  )
}

export function overlayRequestFromManifest(
  manifest: IndexExpansionManifest,
): OverlayLookupRequest {
  const discovery =
    typeof manifest.discovery === 'object' && manifest.discovery != null
      ? (manifest.discovery as {
          mode?: OverlayDiscoveryMode
          hosts?: string[]
          slapTrackers?: string[]
        })
      : null
  return {
    lookupService: manifest.lookupService,
    query: manifest.scope?.query ?? {},
    overlayBaseUrl: manifest.overlayBaseUrl,
    discovery: discovery?.mode ?? 'auto',
    extraHosts: discovery?.hosts,
    slapTrackers: discovery?.slapTrackers,
  }
}
