import { appendAppLog } from './appLog'
import { rememberIndexedOrigins, rememberResolvedSigners, resolvedWithoutSigner } from './inscriptionCache'
import { extractResolved, gorillaBase, indexedOriginSigner, type GpTxo, type ResolvedInscription } from './oneSatImport'
import type { Chain } from './vault'
import { yieldToUi } from './yieldToUi'

/**
 * Origin signers for items whose resolution was cached before signers were
 * kept, and the whole origin for items no hit names at all — a tip moved in
 * by an import keeps its origin locally, so the list never walks it, and the
 * index does not know the fresh move yet. The cache never re-walks a hit, so
 * without this an item would never shelve under its creator in Collect the way
 * Import shows it. One bulk index read per 100 origins, each origin asked once
 * per session; the answer is attribution only, exactly as Import reads it.
 */

const ORIGIN_CHUNK = 100
const askedThisSession = new Set<string>()

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

function originKey(origin: string): string {
  return origin.trim().toLowerCase().replace(/\.(\d+)$/, '_$1')
}

/** Fill missing origin signers for these cached outpoints, and resolve `origins` whole. Returns how many hits changed. */
export async function backfillOriginSigners(args: {
  chain: Chain
  outpoints: readonly string[]
  /** Origins no cached hit names, under the tip or the origin. */
  origins?: readonly string[]
  fetchImpl?: FetchLike
  shouldStop?: () => boolean
}): Promise<number> {
  const tipsByOrigin = new Map<string, string[]>()
  for (const { outpoint, origin } of resolvedWithoutSigner(args.outpoints)) {
    const key = originKey(origin)
    if (askedThisSession.has(key)) continue
    const tips = tipsByOrigin.get(key)
    if (tips) tips.push(outpoint)
    else tipsByOrigin.set(key, [outpoint])
  }
  const whole = new Set((args.origins ?? []).map(originKey).filter((key) => !askedThisSession.has(key)))
  const origins = [...new Set([...tipsByOrigin.keys(), ...whole])]
  if (origins.length === 0) return 0

  const startedAt = Date.now()
  const fetchImpl = args.fetchImpl ?? fetch
  let updated = 0
  let failed = 0
  for (let i = 0; i < origins.length; i += ORIGIN_CHUNK) {
    if (args.shouldStop?.()) break
    const chunk = origins.slice(i, i + ORIGIN_CHUNK)
    for (const origin of chunk) askedThisSession.add(origin)
    let rows: unknown = null
    try {
      const res = await fetchImpl(`${gorillaBase(args.chain)}/api/txos/outpoints?script=false`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(chunk),
        signal: AbortSignal.timeout(20_000),
      })
      if (res.ok) rows = await res.json()
    } catch {
      /* the chunk is asked again next session */
    }
    if (!Array.isArray(rows)) {
      failed += chunk.length
      continue
    }
    const signers = new Map<string, string | null>()
    const resolved = new Map<string, ResolvedInscription>()
    for (const row of rows) {
      const outpoint = (row as { outpoint?: unknown } | null)?.outpoint
      if (typeof outpoint !== 'string') continue
      const key = originKey(outpoint)
      const tips = tipsByOrigin.get(key)
      if (tips) {
        const signer = indexedOriginSigner(row as GpTxo, key)
        for (const tip of tips) signers.set(tip, signer)
      }
      if (whole.has(key)) {
        const origin = extractResolved(row as GpTxo, key)
        if (origin && originKey(origin.origin) === key) resolved.set(key, origin)
      }
    }
    updated += rememberResolvedSigners(signers) + rememberIndexedOrigins(resolved)
    await yieldToUi()
  }
  appendAppLog(
    failed > 0 ? 'warn' : 'info',
    `[collectables] origin signers done ${Date.now() - startedAt}ms origins=${origins.length} whole=${whole.size} updated=${updated} failed=${failed}`,
  )
  return updated
}

export function resetOriginSignerBackfillForTests(): void {
  askedThisSession.clear()
}
