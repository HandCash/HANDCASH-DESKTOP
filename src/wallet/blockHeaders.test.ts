import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetBlockHeaderCacheForTests,
  fetchBlockHeaderForHeight,
  peekHighestCachedHeader,
} from './blockHeaders'

vi.mock('./appLog', () => ({ appendAppLog: () => {} }))

const durableStore = new Map<string, string>()
vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => durableStore.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    durableStore.set(key, value)
    return true
  },
}))

/** Mainnet block 961050, the height an ordinal import kept failing on. */
const BLOCK_961050 = {
  hash: '00000000000000000e2e62982f87d12ca324601202d2756e647ed563814bc1d5',
  height: 961050,
  version: 570425344,
  merkleroot: '9eeba4783ae30192259095ce3f7d80838ef776687e40057aaa2f184fd8b116cb',
  time: 1785984619,
  nonce: 2362473015,
  bits: '182a891d',
  previousBlockHash: '0000000000000000294da54b46a24f633c993c08c4d39f2ee77e8a79f9372928',
}

function respondWith(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}

let height = 961050

beforeEach(() => {
  // Each test uses a fresh height so the module's header cache never answers for it.
  height += 1
  durableStore.clear()
  __resetBlockHeaderCacheForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchBlockHeaderForHeight', () => {
  it('returns a header whose serialization hashes back to the advertised hash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respondWith({ ...BLOCK_961050, height })),
    )

    const header = await fetchBlockHeaderForHeight('main', height)

    expect(header).toMatchObject({
      height,
      hash: BLOCK_961050.hash,
      previousHash: BLOCK_961050.previousBlockHash,
      merkleRoot: BLOCK_961050.merkleroot,
      version: BLOCK_961050.version,
      time: BLOCK_961050.time,
      nonce: BLOCK_961050.nonce,
      // Compact bits arrive as hex and must reach the serializer as a number.
      bits: 0x182a891d,
    })
  })

  it('rejects a header whose fields do not hash to the hash it claims', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respondWith({ ...BLOCK_961050, height, nonce: BLOCK_961050.nonce + 1 })),
    )

    expect(await fetchBlockHeaderForHeight('main', height)).toBeUndefined()
  })

  it('rejects a header that does not meet the proof-of-work its bits claim', async () => {
    // Consistent bytes, but re-mined at a difficulty the hash cannot satisfy.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respondWith({ ...BLOCK_961050, height, bits: '18000001' })),
    )

    expect(await fetchBlockHeaderForHeight('main', height)).toBeUndefined()
  })

  it('moves to the next source when the first cannot serve the height', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('arcade-v2') || url.includes('bsvblockchain.tech')) {
        return respondWith(null, false)
      }
      if (url.includes('/v1/chain/header/')) return respondWith(null, false)
      if (url.includes('bitails')) return respondWith(null, false)
      return respondWith({ ...BLOCK_961050, height })
    })
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchBlockHeaderForHeight('main', height)).toMatchObject({ hash: BLOCK_961050.hash })
    expect(fetchMock.mock.calls.some(([url]) => url.includes('whatsonchain'))).toBe(true)
  })

  it('serves a repeated height from cache rather than the network', async () => {
    const fetchMock = vi.fn(async () => respondWith({ ...BLOCK_961050, height }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchBlockHeaderForHeight('main', height)
    const afterFirst = fetchMock.mock.calls.length
    await fetchBlockHeaderForHeight('main', height)

    expect(fetchMock.mock.calls.length).toBe(afterFirst)
  })

  it('refuses a body that describes a different block than the one asked for', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respondWith(BLOCK_961050)),
    )

    expect(await fetchBlockHeaderForHeight('main', height)).toBeUndefined()
  })

  it('serves a cold start from durable rather than the network', async () => {
    const fetchMock = vi.fn(async () => respondWith({ ...BLOCK_961050, height }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchBlockHeaderForHeight('main', height)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0)

    __resetBlockHeaderCacheForTests()
    fetchMock.mockClear()
    const again = await fetchBlockHeaderForHeight('main', height)
    expect(again).toMatchObject({ hash: BLOCK_961050.hash, height })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('demotes HandCash Chain after repeated misses so later heights skip it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/v1/chain/header/')) return respondWith(null, false)
      if (url.includes('arcade-v2') || url.includes('bsvblockchain.tech')) {
        return respondWith(null, false)
      }
      if (url.includes('bitails')) return respondWith(null, false)
      return respondWith({ ...BLOCK_961050, height })
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      for (let i = 0; i < 3; i += 1) {
        height += 1
        await fetchBlockHeaderForHeight('main', height)
        // Expire the short miss cooldown so the next height can observe a streak.
        await vi.advanceTimersByTimeAsync(60_000 + 1)
      }
      const chainHits = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/v1/chain/header/'),
      ).length
      expect(chainHits).toBe(3)

      fetchMock.mockClear()
      // Still inside the 15m demote window (only ~3m advanced above).
      height += 1
      await fetchBlockHeaderForHeight('main', height)
      const chainHitsAfter = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/v1/chain/header/'),
      ).length
      expect(chainHitsAfter).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('peekHighestCachedHeader', () => {
  it('returns the highest verified header already in cache', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respondWith({ ...BLOCK_961050, height })),
    )
    const header = await fetchBlockHeaderForHeight('main', height)
    expect(header?.height).toBe(height)
    expect(peekHighestCachedHeader('main')?.height).toBe(height)
    expect(peekHighestCachedHeader('test')).toBeUndefined()
  })
})
