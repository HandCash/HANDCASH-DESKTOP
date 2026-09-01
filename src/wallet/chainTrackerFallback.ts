/**
 * A chain tracker that will not reject a payment it merely cannot see yet.
 *
 * `Beef.verify` asks one question — "is this merkle root the real root at this
 * height?" — and everything that brings value into the wallet depends on the
 * answer: internalizing an ordinal, the AtomicBEEF check on a received item, the
 * input BEEF on a legacy sweep, the monitor's proof review.
 *
 * The interface only allows `true` or `false`, and that is the trap. A tracker
 * whose header store is behind the chain tip answers `false` for a height it has
 * simply never reached — indistinguishable, to the caller, from "this proof is
 * forged". The Chaintracks host sat 72 blocks behind while the user's payment was
 * mined above it, so every recent deposit was declared invalid and surfaced as
 * "valid AtomicBEEF" or "valid Beef when factoring options.trustSelf": wording
 * that blames the data for what was really a stale index.
 *
 * So `false` is only believed from a source that demonstrably holds the height in
 * question. Anything else — an error, a timeout, a height past the source's tip,
 * a 404 — is "unknown", and the question moves to the next source. `true` needs a
 * source to affirmatively confirm the root, so nothing is ever waved through
 * unverified. When no source can answer we throw rather than deny, because a
 * denial is permanent and wrong while a throw is retried on the next sync.
 */
import type { ChainTracker } from '@bsv/sdk'

import { appendAppLog } from './appLog'
import { DEFAULT_BRC_CLOUD_BASE_URL } from './walletConfig'
import { arcadeV2BaseUrl } from './arcadeV2'
import type { Chain } from './vault'

type Verdict = 'valid' | 'invalid' | 'unknown'

/** A source that can be asked for the canonical merkle root at a height. */
type HeaderSource = {
  name: string
  /** The root at `height`, or null when this source cannot say. */
  rootAt: (height: number) => Promise<string | null>
  /** This source's chain tip, or null when unreachable. */
  tip: () => Promise<number | null>
}

const REQUEST_TIMEOUT_MS = 8_000
/**
 * Chaintracks often hangs until the browser fires `net::ERR_TIMED_OUT` (~30s+).
 * Fail over to Bitails / WoC long before that so ingest and verify stay live.
 */
const CHAINTRACKS_FAST_FAIL_MS = 3_000
/** A tip moves every ~10 minutes; re-asking more often than this buys nothing. */
const TIP_CACHE_MS = 30_000
/** Don't re-probe a source that just failed on every single root. */
const SOURCE_COOLDOWN_MS = 60_000
/** Roots are immutable per height, so verdicts are cached — but bounded. */
const VERDICT_CACHE_MAX = 500

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

async function fetchJson(url: string): Promise<unknown | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    // A rate-limited response has no CORS headers in a WebView and lands in the
    // catch below as a network error; a 404 lands here. Neither is an answer.
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function numberAt(body: unknown, key: string): number | null {
  const value = (body as Record<string, unknown> | null)?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringAt(body: unknown, key: string): string | null {
  const value = (body as Record<string, unknown> | null)?.[key]
  return typeof value === 'string' && value !== '' ? value : null
}

function whatsOnChainSource(chain: Chain): HeaderSource {
  const base = `https://api.whatsonchain.com/v1/bsv/${chain === 'main' ? 'main' : 'test'}`
  return {
    name: 'WhatsOnChain',
    rootAt: async (height) =>
      stringAt(await fetchJson(`${base}/block/${height}/header`), 'merkleroot'),
    tip: async () => numberAt(await fetchJson(`${base}/chain/info`), 'blocks'),
  }
}

/**
 * Mainnet only, and deliberately tried first.
 *
 * The toolbox's own service rotation leans on WhatsOnChain for raw transactions,
 * UTXO scans and exchange rates, so by the time a merkle root needs checking the
 * device is often already rate-limited there — which a WebView reports as an
 * indistinguishable network failure. Bitails is a second opinion under a
 * separate budget.
 */
function bitailsSource(): HeaderSource {
  return {
    name: 'Bitails',
    rootAt: async (height) =>
      stringAt(await fetchJson(`https://api.bitails.io/block/height/${height}`), 'merkleroot'),
    tip: async () => numberAt(await fetchJson('https://api.bitails.io/block/latest'), 'height'),
  }
}

/** Arcade V2 go-chaintracks — Babbage wallet-services header store. */
function arcadeV2Source(chain: Chain): HeaderSource | null {
  const base = arcadeV2BaseUrl(chain)
  if (!base) return null
  return {
    name: 'Arcade V2',
    rootAt: async (height) => {
      const body = await fetchJson(`${base}/chaintracks/v2/header/height/${height}`)
      return stringAt(body, 'merkleRoot') ?? stringAt(body, 'merkleroot')
    },
    tip: async () => numberAt(await fetchJson(`${base}/chaintracks/v2/tip`), 'height'),
  }
}

/** BRC-CLOUD HandCash Chain — KV-cached headers with Bitails/WoC upstream. */
function handcashChainSource(): HeaderSource {
  const base = DEFAULT_BRC_CLOUD_BASE_URL.replace(/\/+$/, '')
  return {
    name: 'HandCash Chain',
    rootAt: async (height) =>
      stringAt(await fetchJson(`${base}/v1/chain/merkleroot/${height}`), 'merkleroot'),
    tip: async () => numberAt(await fetchJson(`${base}/v1/chain/tip`), 'height'),
  }
}

/** Wraps the toolbox's own tracker, which can only be asked yes/no. */
function primarySource(primary: ChainTracker): {
  name: string
  check: (root: string, height: number) => Promise<Verdict>
} {
  let cachedTip: { height: number; at: number } | null = null

  const tip = async (): Promise<number | null> => {
    if (cachedTip != null && Date.now() - cachedTip.at < TIP_CACHE_MS) return cachedTip.height
    try {
      const height = await withTimeout(
        primary.currentHeight(),
        CHAINTRACKS_FAST_FAIL_MS,
      )
      if (!Number.isFinite(height)) return null
      cachedTip = { height, at: Date.now() }
      return height
    } catch {
      return null
    }
  }

  return {
    name: 'Arcade V2',
    check: async (root, height) => {
      // Without knowing how far this tracker has synced, its `false` cannot be
      // told apart from "not there yet" — so refuse to interpret it.
      const known = await tip()
      if (known == null || height > known) return 'unknown'
      try {
        return (await primary.isValidRootForHeight(root, height)) ? 'valid' : 'invalid'
      } catch {
        return 'unknown'
      }
    },
  }
}

export function createFallbackChainTracker(
  chain: Chain,
  primary: ChainTracker | null,
): ChainTracker {
  const arcade = arcadeV2Source(chain)
  const headerSources: HeaderSource[] = [
    ...(arcade ? [arcade] : []),
    ...(chain === 'main' ? [handcashChainSource(), bitailsSource()] : []),
    whatsOnChainSource(chain),
  ]
  const first = primary != null ? primarySource(primary) : null

  const cooldownUntil = new Map<string, number>()
  const verdicts = new Map<string, boolean>()
  let loggedStale = false

  const usable = (name: string): boolean => Date.now() >= (cooldownUntil.get(name) ?? 0)

  function noteUnreachable(name: string): void {
    cooldownUntil.set(name, Date.now() + SOURCE_COOLDOWN_MS)
  }

  function remember(key: string, valid: boolean): void {
    verdicts.set(key, valid)
    while (verdicts.size > VERDICT_CACHE_MAX) {
      const oldest = verdicts.keys().next()
      if (oldest.done === true) break
      verdicts.delete(oldest.value)
    }
  }

  async function checkHeaderSource(
    source: HeaderSource,
    root: string,
    height: number,
  ): Promise<Verdict> {
    const actual = await source.rootAt(height)
    if (actual == null) {
      noteUnreachable(source.name)
      return 'unknown'
    }
    return actual.toLowerCase() === root.toLowerCase() ? 'valid' : 'invalid'
  }

  return {
    async isValidRootForHeight(root: string, height: number): Promise<boolean> {
      const key = `${height}:${root.toLowerCase()}`
      const cached = verdicts.get(key)
      if (cached !== undefined) return cached

      let denied: string | null = null

      if (first != null && usable(first.name)) {
        const verdict = await first.check(root, height)
        if (verdict === 'valid') {
          remember(key, true)
          return true
        }
        // Keep the denial but keep asking: a stale tracker sounds exactly like
        // this, and it is the reason deposits were being thrown away.
        if (verdict === 'invalid') denied = first.name
        else noteUnreachable(first.name)
      }

      for (const source of headerSources) {
        if (!usable(source.name)) continue
        const verdict = await checkHeaderSource(source, root, height)
        if (verdict === 'valid') {
          if (denied != null && !loggedStale) {
            loggedStale = true
            appendAppLog(
              'warn',
              `[chaintracker] ${denied} rejected a root ${source.name} confirms at height ${height} — treating it as behind the tip`,
            )
          }
          remember(key, true)
          return true
        }
        if (verdict === 'invalid') {
          // A source that served the header and disagrees about its root has
          // genuinely answered the question.
          remember(key, false)
          return false
        }
      }

      // Reached only when nothing could serve the header. A denial from the
      // primary is deliberately not enough to end up here as `false`: it reports
      // a tip separately from what its store can actually serve, so its `false`
      // may still just mean "not indexed yet". Throwing is retried on the next
      // sync; denying is permanent and silently eats the deposit.
      throw new Error(
        denied != null
          ? `${denied} rejected the merkle root at height ${height} and no independent source could confirm or refute it`
          : `no chain tracker could confirm the merkle root at height ${height}`,
      )
    },

    async currentHeight(): Promise<number> {
      if (first != null && usable(first.name)) {
        try {
          const height = await withTimeout(
            primary!.currentHeight(),
            CHAINTRACKS_FAST_FAIL_MS,
          )
          if (Number.isFinite(height)) return height
        } catch {
          noteUnreachable(first.name)
        }
      }
      for (const source of headerSources) {
        if (!usable(source.name)) continue
        const height = await source.tip()
        if (height != null) return height
        noteUnreachable(source.name)
      }
      throw new Error('no chain tracker could report the current height')
    },
  }
}
