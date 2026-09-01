/**
 * Upstream dependency probes — HandCash Chain, Bitails, ord content.
 * Logged on Refresh and surfaced in Settings → Support so outages are visible
 * before they wedge sends behind a long sync.
 */

import { DEFAULT_BRC_CLOUD_BASE_URL } from './walletConfig'

export type DependencyProbeStatus = 'ok' | 'degraded' | 'down' | 'unknown'

export type DependencyProbe = {
  id: string
  label: string
  status: DependencyProbeStatus
  detail: string
  latencyMs: number | null
}

export type DependencyHealthSnapshot = {
  at: number
  probes: DependencyProbe[]
  summary: string
}

type Listener = (snapshot: DependencyHealthSnapshot) => void

const PROBE_TIMEOUT_MS = 5_000

let cached: DependencyHealthSnapshot = {
  at: 0,
  probes: [],
  summary: 'Not checked yet',
}

const listeners = new Set<Listener>()

function statusFromHttp(code: number, timedOut: boolean): DependencyProbeStatus {
  if (timedOut) return 'down'
  if (code >= 200 && code < 400) return 'ok'
  if (code === 404 || code === 405) return 'ok'
  if (code >= 400 && code < 500) return 'degraded'
  return 'down'
}

async function probeUrl(
  url: string,
  init?: RequestInit,
): Promise<{ code: number; timedOut: boolean; latencyMs: number }> {
  const started = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: 'no-store',
    })
    return {
      code: res.status,
      timedOut: false,
      latencyMs: Math.round(performance.now() - started),
    }
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'AbortError'
    return {
      code: 0,
      timedOut,
      latencyMs: timedOut ? PROBE_TIMEOUT_MS : Math.round(performance.now() - started),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function probeArcadeV2(): Promise<DependencyProbe> {
  const { code, timedOut, latencyMs } = await probeUrl(
    'https://arcade-v2-us-1.bsvblockchain.tech/chaintracks/v2/height',
    { headers: { Accept: 'application/json' } },
  )
  const status = statusFromHttp(code, timedOut)
  const detail =
    status === 'ok'
      ? `${latencyMs}ms`
      : timedOut
        ? 'Timeout'
        : code === 0
          ? 'Down'
          : `HTTP ${code}`
  return { id: 'arcade-v2', label: 'Arcade V2', status, detail, latencyMs }
}

async function probeHandcashChain(): Promise<DependencyProbe> {
  const base = DEFAULT_BRC_CLOUD_BASE_URL.replace(/\/+$/, '')
  const started = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(`${base}/v1/chain/health`, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    })
    const latencyMs = Math.round(performance.now() - started)
    let status: DependencyProbeStatus = statusFromHttp(res.status, false)
    let detail =
      status === 'ok'
        ? `${latencyMs}ms`
        : res.status >= 400
          ? `HTTP ${res.status}`
          : 'Down'
    if (status === 'ok') {
      try {
        const body = (await res.json()) as { ok?: unknown }
        if (body.ok !== true) {
          status = 'degraded'
          detail = 'Unhealthy'
        }
      } catch {
        status = 'degraded'
        detail = 'Unreadable'
      }
    }
    return { id: 'handcash-chain', label: 'HandCash Chain', status, detail, latencyMs }
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'AbortError'
    const latencyMs = timedOut ? PROBE_TIMEOUT_MS : Math.round(performance.now() - started)
    const status = statusFromHttp(0, timedOut)
    const detail = timedOut ? 'Timeout' : 'Down'
    return { id: 'handcash-chain', label: 'HandCash Chain', status, detail, latencyMs }
  } finally {
    clearTimeout(timer)
  }
}

async function probeBitails(): Promise<DependencyProbe> {
  const { code, timedOut, latencyMs } = await probeUrl(
    'https://api.bitails.io/block/latest',
    { headers: { Accept: 'application/json' } },
  )
  const status = statusFromHttp(code, timedOut)
  const detail =
    status === 'ok'
      ? `${latencyMs}ms`
      : timedOut
        ? 'Timeout'
        : code === 0
          ? 'Down'
          : `HTTP ${code}`
  return { id: 'bitails', label: 'Bitails', status, detail, latencyMs }
}

async function probeBananaBlocks(): Promise<DependencyProbe> {
  const { code, timedOut, latencyMs } = await probeUrl(
    'https://bananablocks.com/api/v1/bsv/main/chain/info',
    { headers: { Accept: 'application/json' } },
  )
  const status = statusFromHttp(code, timedOut)
  const detail =
    status === 'ok'
      ? `${latencyMs}ms`
      : timedOut
        ? 'Timeout'
        : code === 0
          ? 'Down'
          : `HTTP ${code}`
  return { id: 'bananablocks', label: 'BananaBlocks', status, detail, latencyMs }
}

async function probeKallubi(): Promise<DependencyProbe> {
  const { code, timedOut, latencyMs } = await probeUrl(
    'https://bsv.cx/tx/' + 'a'.repeat(64),
    { headers: { Accept: 'application/json' } },
  )
  const status = statusFromHttp(code, timedOut)
  const detail =
    status === 'ok'
      ? `${latencyMs}ms`
      : timedOut
        ? 'Timeout'
        : code === 0
          ? 'Down'
          : `HTTP ${code}`
  return { id: 'kallubi', label: 'Kallubi', status, detail, latencyMs }
}

async function probeGorillaPool(): Promise<DependencyProbe> {
  const { code, timedOut, latencyMs } = await probeUrl(
    'https://ordinals.gorillapool.io/favicon.ico',
    { method: 'HEAD' },
  )
  const status = statusFromHttp(code, timedOut)
  const detail =
    status === 'ok'
      ? `${latencyMs}ms`
      : timedOut
        ? 'Timeout'
        : 'Down'
  return { id: 'gorillapool', label: 'Ordinals', status, detail, latencyMs }
}

function summarize(probes: DependencyProbe[]): string {
  const down = probes.filter((p) => p.status === 'down')
  const degraded = probes.filter((p) => p.status === 'degraded')
  if (down.length > 0) {
    return down.length === 1 ? `${down[0]!.label} down` : `${down.length} down`
  }
  if (degraded.length > 0) {
    return degraded.length === 1 ? `${degraded[0]!.label} slow` : `${degraded.length} slow`
  }
  return 'All OK'
}

/** Worst status across probes — drives Settings → Wallet health badge. */
export function dependencyHealthAlert(
  snapshot: DependencyHealthSnapshot,
): 'unknown' | 'ok' | 'warn' | 'error' {
  if (snapshot.at === 0 || snapshot.probes.length === 0) return 'unknown'
  if (snapshot.probes.some((p) => p.status === 'down')) return 'error'
  if (snapshot.probes.some((p) => p.status === 'degraded')) return 'warn'
  return 'ok'
}

export function getDependencyHealthSnapshot(): DependencyHealthSnapshot {
  return cached
}

export function subscribeDependencyHealth(listener: Listener): () => void {
  listeners.add(listener)
  listener(cached)
  return () => {
    listeners.delete(listener)
  }
}

/** Run probes once; safe to call from Settings or after Refresh. */
export async function refreshDependencyHealth(): Promise<DependencyHealthSnapshot> {
  const [arcadeV2, handcashChain, bitails, bananablocks, kallubi, gorillapool] =
    await Promise.all([
      probeArcadeV2(),
      probeHandcashChain(),
      probeBitails(),
      probeBananaBlocks(),
      probeKallubi(),
      probeGorillaPool(),
    ])
  const probes = [arcadeV2, handcashChain, bitails, bananablocks, kallubi, gorillapool]
  const summary = summarize(probes)
  cached = { at: Date.now(), probes, summary }
  console.info(`[dependency-health] ${summary}`)
  for (const probe of probes) {
    console.info(`[dependency-health] ${probe.label}: ${probe.status} — ${probe.detail}`)
  }
  for (const listener of listeners) listener(cached)
  return cached
}
