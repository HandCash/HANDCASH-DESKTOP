import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createFallbackChainTracker } from './chainTrackerFallback'

vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))

const TIP = 961_111
const HEIGHT = 961_052
const ROOT = 'fbd650983b63bc1443693924030543634a528d91babfed2ec28836d93e5de275'

/** Route the header endpoints; anything not listed behaves as unreachable. */
function mockHosts(hosts: { bitails?: boolean; woc?: boolean }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const up =
        (hosts.bitails === true && url.includes('bitails.io')) ||
        (hosts.woc === true && url.includes('whatsonchain.com'))
      if (!up) throw new TypeError('Failed to fetch')
      const body = url.includes('latest') || url.includes('chain/info')
        ? { height: TIP, blocks: TIP }
        : { height: HEIGHT, merkleroot: ROOT }
      return { ok: true, json: async () => body } as unknown as Response
    }),
  )
}

/** The observed outage: a tracker 72 blocks behind, answering `false`. */
function staleTracker(storeTip: number) {
  return {
    isValidRootForHeight: vi.fn(async (_root: string, height: number) => height <= storeTip),
    currentHeight: vi.fn(async () => storeTip),
  }
}

beforeEach(() => {
  mockHosts({ bitails: true, woc: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createFallbackChainTracker', () => {
  it('does not let a tracker behind the tip reject a mined payment', async () => {
    // Chaintracks sat at 961039 while the deposit was mined at 961052. Its
    // `false` meant "not indexed yet", but the caller read it as "forged proof"
    // and every recent deposit was discarded.
    const primary = staleTracker(961_039)
    const tracker = createFallbackChainTracker('main', primary)

    expect(await tracker.isValidRootForHeight(ROOT, HEIGHT)).toBe(true)
    // It should not even have been asked about a height it cannot hold.
    expect(primary.isValidRootForHeight).not.toHaveBeenCalled()
  })

  it('will not deny on a stale tracker even when it claims a current tip', async () => {
    // A tracker can report the real tip while its header store lags, so its
    // denial is never enough on its own.
    const primary = {
      isValidRootForHeight: vi.fn(async () => false),
      currentHeight: vi.fn(async () => TIP),
    }
    const tracker = createFallbackChainTracker('main', primary)

    expect(await tracker.isValidRootForHeight(ROOT, HEIGHT)).toBe(true)
    expect(primary.isValidRootForHeight).toHaveBeenCalledTimes(1)
  })

  it('still rejects a genuinely wrong root', async () => {
    const tracker = createFallbackChainTracker('main', null)
    expect(await tracker.isValidRootForHeight('f'.repeat(64), HEIGHT)).toBe(false)
  })

  it('accepts a root the primary confirms without any network call', async () => {
    const primary = staleTracker(TIP)
    const tracker = createFallbackChainTracker('main', primary)

    expect(await tracker.isValidRootForHeight(ROOT, HEIGHT)).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('falls through to Bitails when WhatsOnChain is rate-limited', async () => {
    // A throttled response carries no CORS headers, so the WebView reports it
    // as a network failure indistinguishable from the host being down.
    mockHosts({ bitails: true, woc: false })
    const tracker = createFallbackChainTracker('main', null)

    expect(await tracker.isValidRootForHeight(ROOT, HEIGHT)).toBe(true)
  })

  it('throws rather than denying when nothing can answer', async () => {
    // Denial is permanent and would discard a real deposit; a throw is retried.
    mockHosts({})
    const tracker = createFallbackChainTracker('main', staleTracker(961_039))

    await expect(tracker.isValidRootForHeight(ROOT, HEIGHT)).rejects.toThrow(
      /could not confirm|no chain tracker could confirm/i,
    )
  })

  it('caches a verdict instead of re-asking per BEEF', async () => {
    const tracker = createFallbackChainTracker('main', null)

    await tracker.isValidRootForHeight(ROOT, HEIGHT)
    const afterFirst = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    await tracker.isValidRootForHeight(ROOT, HEIGHT)

    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(afterFirst)
  })

  it('reports a height even when the primary is down', async () => {
    const primary = {
      isValidRootForHeight: vi.fn(async () => false),
      currentHeight: vi.fn(async () => {
        throw new Error('ERR_INTERNAL: At least one bulk ingestor must implement getPresentHeight.')
      }),
    }
    const tracker = createFallbackChainTracker('main', primary)

    expect(await tracker.currentHeight()).toBe(TIP)
  })
})
