import { appendAppLog } from '../appLog'
import type { KeyDeriver } from './importSource'

/**
 * Does this HandCash export own `$handle`?
 *
 * HandCash publishes each handle's identity key through paymail PKI. When a
 * key composed from the two shares equals it, the export provably controls
 * the handle and the user can claim the same name for this wallet (BRC-169,
 * via the claim site). No match is not a refusal — older handles may be keyed
 * elsewhere — it only means the proof is unavailable.
 */

export type HandleProbe = {
  handle: string
  /** Identity key HandCash PKI returned, or null when it did not answer. */
  pubkey: string | null
  /** Share path whose composed key matches `pubkey`. */
  match: string | null
  checkedAt: number
  error: string | null
}

const PKI_BASE = 'https://cloud.handcash.io/api/bsvalias/id'
const PROBE_ROOTS = 10
const PROBE_INDICES = 5

export function normalizeHandCashHandle(raw: string): string | null {
  const handle = raw.trim().replace(/^\$/, '').replace(/@handcash\.io$/i, '').toLowerCase()
  return /^[a-z0-9][a-z0-9._-]{0,49}$/.test(handle) ? handle : null
}

/** Paths whose composed key is compared against the handle's PKI key. */
export function handleProbePaths(): string[] {
  const paths = ['m']
  for (let root = 0; root < PROBE_ROOTS; root += 1) {
    for (let i = 0; i < PROBE_INDICES; i += 1) paths.push(`m/${root}/${i}`)
  }
  return paths
}

export function matchHandleKey(deriver: KeyDeriver, pubkey: string): string | null {
  const wanted = pubkey.trim().toLowerCase()
  for (const path of handleProbePaths()) {
    if (deriver.privateKeyAt(path).toPublicKey().toString().toLowerCase() === wanted) return path
  }
  return null
}

export async function probeHandCashHandle(
  rawHandle: string,
  deriver: KeyDeriver,
  fetchImpl: typeof fetch = fetch,
): Promise<HandleProbe> {
  const handle = normalizeHandCashHandle(rawHandle)
  if (!handle) throw new Error('Enter a HandCash handle, e.g. $alice')
  const base: HandleProbe = { handle, pubkey: null, match: null, checkedAt: Date.now(), error: null }
  try {
    const res = await fetchImpl(`${PKI_BASE}/${encodeURIComponent(handle)}@handcash.io`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 404) return { ...base, error: 'HandCash does not know that handle' }
    if (!res.ok) return { ...base, error: `HandCash PKI ${res.status}` }
    const body = (await res.json()) as { pubkey?: unknown }
    const pubkey = typeof body.pubkey === 'string' ? body.pubkey.trim().toLowerCase() : null
    if (!pubkey || !/^0[23][0-9a-f]{64}$/.test(pubkey)) {
      return { ...base, error: 'HandCash PKI returned no identity key' }
    }
    const match = matchHandleKey(deriver, pubkey)
    appendAppLog('info', `[import] handle probe $${handle} match=${match ?? 'none'}`)
    return { ...base, pubkey, match }
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) }
  }
}
