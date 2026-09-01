/**
 * Upstream dependency probes — Chaintracks, Bitails, ord content.
 * Logged on Refresh and surfaced in Settings → Support so outages are visible
 * before they wedge sends behind a long sync.
 */

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

async function probeChaintracks(): Promise<DependencyProbe> {
  const { code, timedOut, latencyMs } = await probeUrl(
    'https://api.chaintracks.com/v1/chain/header',
    { headers: { Accept: 'application/json' } },
  )
  const status = statusFromHttp(code, timedOut)
  const detail =
    status === 'ok'
      ? `HTTP ${code} · ${latencyMs}ms`
      : timedOut
        ? 'Timed out — Bitails header fallback is in use'
        : code === 0
          ? 'Unreachable — Bitails header fallback is in use'
          : `HTTP ${code} — Bitails header fallback is in use`
  return { id: 'chaintracks', label: 'Chaintracks', status, detail, latencyMs }
}

async function probeBitails(): Promise<DependencyProbe> {
  const { code, timedOut, latencyMs } = await probeUrl(
    'https://api.bitails.io/block/latest',
    { headers: { Accept: 'application/json' } },
  )
  const status = statusFromHttp(code, timedOut)
  const detail =
    status === 'ok'
      ? `HTTP ${code} · ${latencyMs}ms (header + raw-tx fallback)`
      : timedOut
        ? 'Timed out — Refresh and change heal may stall'
        : code === 0
          ? 'Unreachable — Refresh and change heal may stall'
          : `HTTP ${code}`
  return { id: 'bitails', label: 'Bitails', status, detail, latencyMs }
}

async function probeGorillaPool(): Promise<DependencyProbe> {
  const { code, timedOut, latencyMs } = await probeUrl(
    'https://ordinals.gorillapool.io/content',
    { method: 'HEAD' },
  )
  const status = statusFromHttp(code, timedOut)
  const detail =
    status === 'ok'
      ? `Reachable · ${latencyMs}ms (collectable media)`
      : timedOut
        ? 'Timed out — thumbnails may skeleton longer'
        : 'Unreachable — thumbnails may skeleton longer'
  return { id: 'gorillapool', label: 'GorillaPool ord', status, detail, latencyMs }
}

function summarize(probes: DependencyProbe[]): string {
  const down = probes.filter((p) => p.status === 'down')
  const degraded = probes.filter((p) => p.status === 'degraded')
  if (down.length > 0) {
    return `${down.map((p) => p.label).join(', ')} down`
  }
  if (degraded.length > 0) {
    return `${degraded.map((p) => p.label).join(', ')} degraded`
  }
  return 'Network dependencies OK'
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
  const [chaintracks, bitails, gorillapool] = await Promise.all([
    probeChaintracks(),
    probeBitails(),
    probeGorillaPool(),
  ])
  const probes = [chaintracks, bitails, gorillapool]
  const summary = summarize(probes)
  cached = { at: Date.now(), probes, summary }
  console.info(`[dependency-health] ${summary}`)
  for (const probe of probes) {
    console.info(`[dependency-health] ${probe.label}: ${probe.status} — ${probe.detail}`)
  }
  for (const listener of listeners) listener(cached)
  return cached
}
