import { appendAppLog } from './appLog'
import { rememberResolvedSigners, resolvedWithoutSigner } from './inscriptionCache'
import { gorillaBase, indexedOriginSigner, type GpTxo } from './oneSatImport'
import type { Chain } from './vault'
import { yieldToUi } from './yieldToUi'

/**
 * Origin signers for items whose resolution was cached before signers were
 * kept. The cache never re-walks a hit, so without this an item resolved last
 * week would never shelve under its creator in Collect the way Import shows
 * it. One bulk index read per 100 origins, each origin asked once per session;
 * the answer is attribution only, exactly as Import reads it.
 */

const ORIGIN_CHUNK = 100
const askedThisSession = new Set<string>()

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

function originKey(origin: string): string {
  return origin.trim().toLowerCase().replace(/\.(\d+)$/, '_$1')
}

/** Fill missing origin signers for these cached outpoints. Returns how many hits changed. */
export async function backfillOriginSigners(args: {
  chain: Chain
  outpoints: readonly string[]
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
  if (tipsByOrigin.size === 0) return 0

  const startedAt = Date.now()
  const fetchImpl = args.fetchImpl ?? fetch
  const origins = [...tipsByOrigin.keys()]
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
    for (const row of rows) {
      const outpoint = (row as { outpoint?: unknown } | null)?.outpoint
      if (typeof outpoint !== 'string') continue
      const key = originKey(outpoint)
      const tips = tipsByOrigin.get(key)
      if (!tips) continue
      const signer = indexedOriginSigner(row as GpTxo, key)
      for (const tip of tips) signers.set(tip, signer)
    }
    updated += rememberResolvedSigners(signers)
    await yieldToUi()
  }
  appendAppLog(
    failed > 0 ? 'warn' : 'info',
    `[collectables] origin signers done ${Date.now() - startedAt}ms origins=${origins.length} updated=${updated} failed=${failed}`,
  )
  return updated
}

export function resetOriginSignerBackfillForTests(): void {
  askedThisSession.clear()
}
