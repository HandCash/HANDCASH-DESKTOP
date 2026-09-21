/**
 * TaskNewHeader polls `findChainTipHeader` every few seconds. Throwing when
 * every host is unreachable becomes `WERR_UNKNOWN No chain tip header provider`
 * on a tight loop (lab: 117 times in ~50 minutes of a local dropout). The
 * monitor only needs a header object; a last-known tip is "no new block",
 * which is the truth until a provider answers again.
 */
import { fetchBlockHeaderForHeight, peekHighestCachedHeader } from './blockHeaders'
import { appendAppLog } from './appLog'
import type { Chain } from './vault'

const ORIGINAL_TIMEOUT_MS = 3_000
const BITAILS_TIMEOUT_MS = 8_000
const STALE_LOG_MS = 60_000

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms)
      }),
    ])
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}

function headerHeight(value: unknown): number | undefined {
  if (value == null || typeof value !== 'object') return undefined
  const height = (value as { height?: unknown }).height
  return typeof height === 'number' && Number.isFinite(height) ? height : undefined
}

function bitailsLatestUrl(chain: Chain): string | null {
  if (chain === 'main') return 'https://api.bitails.io/block/latest'
  if (chain === 'test') return 'https://test-api.bitails.io/block/latest'
  return null
}

async function tipFromBitails(chain: Chain): Promise<unknown | undefined> {
  const tipUrl = bitailsLatestUrl(chain)
  if (tipUrl == null) return undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), BITAILS_TIMEOUT_MS)
  try {
    const res = await fetch(tipUrl, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return undefined
    const body = (await res.json()) as { height?: number }
    const height = body.height
    if (typeof height !== 'number' || !Number.isFinite(height)) return undefined
    return await fetchBlockHeaderForHeight(chain, height)
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

export function wrapFindChainTipHeader(
  chain: Chain,
  original: () => Promise<unknown>,
): () => Promise<unknown> {
  let lastGood: unknown
  let loggedLive = false
  let lastStaleLogAt = 0

  return async () => {
    const fromBitails = await tipFromBitails(chain)
    if (fromBitails != null) {
      lastGood = fromBitails
      if (!loggedLive) {
        loggedLive = true
        const height = headerHeight(fromBitails)
        appendAppLog(
          'info',
          `[headers] NewHeader tip from Bitails${height != null ? ` height ${height}` : ''}`,
        )
      }
      return fromBitails
    }
    try {
      const tip = await withTimeout(original(), ORIGINAL_TIMEOUT_MS)
      if (tip != null) {
        lastGood = tip
        return tip
      }
    } catch {
      /* public paths exhausted */
    }
    const held = lastGood ?? peekHighestCachedHeader(chain)
    if (held != null) {
      lastGood = held
      const now = Date.now()
      if (now - lastStaleLogAt >= STALE_LOG_MS) {
        lastStaleLogAt = now
        const height = headerHeight(held)
        appendAppLog(
          'warn',
          `[headers] NewHeader holding last tip${height != null ? ` height ${height}` : ''} — no live provider`,
        )
      }
      return held
    }
    throw new Error('No chain tip header provider')
  }
}
