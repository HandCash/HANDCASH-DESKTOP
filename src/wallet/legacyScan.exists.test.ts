import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetLegacyScanCooldownForTests, txExistsOnChain } from './legacyScan'

const TXID = 'ab'.repeat(32)

afterEach(() => {
  vi.unstubAllGlobals()
  resetLegacyScanCooldownForTests()
})

const isBitails = (url: unknown) => String(url).includes('bitails')
const isCloud = (url: unknown) =>
  String(url).includes('/v1/chain/tx/') && String(url).includes('/exists')

/** HandCash Chain must not block direct providers when it has no answer. */
function cloudSilentThen(
  next: (url: string) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    if (isCloud(url)) return new Response('', { status: 503 })
    return next(url)
  })
}

describe('txExistsOnChain', () => {
  it('asks Bitails before WhatsOnChain when HandCash Chain is silent', async () => {
    const order: string[] = []
    const fetchMock = cloudSilentThen(async (url) => {
      order.push(isBitails(url) ? 'bitails' : 'woc')
      if (isBitails(url)) return new Response('', { status: 404 })
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(txExistsOnChain(TXID, 'main')).resolves.toBe(false)
    expect(order).toEqual(['bitails'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses HandCash Chain when it has a definitive answer', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (isCloud(url)) {
        return Response.json({ exists: true, source: 'bitails' })
      }
      return new Response('', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(txExistsOnChain(TXID, 'main')).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to WhatsOnChain only when Bitails is silent', async () => {
    const fetchMock = cloudSilentThen(async (url: string) => {
      if (isBitails(url)) return new Response('', { status: 500 })
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(txExistsOnChain(TXID, 'main')).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('affirms presence when either provider has seen the tx', async () => {
    vi.stubGlobal(
      'fetch',
      cloudSilentThen(async (url: string) =>
        isBitails(url)
          ? new Response('', { status: 500 })
          : new Response('{}', { status: 200 }),
      ),
    )
    await expect(txExistsOnChain(TXID, 'main')).resolves.toBe(true)
  })

  it('reports absent only when a provider answered 404 and none affirmed', async () => {
    vi.stubGlobal('fetch', cloudSilentThen(async () => new Response('', { status: 404 })))
    await expect(txExistsOnChain(TXID, 'main')).resolves.toBe(false)
  })

  it('fails closed with null when every provider is silent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    await expect(txExistsOnChain(TXID, 'main')).resolves.toBeNull()
  })

  it('trusts Bitails 404 without calling WhatsOnChain', async () => {
    const fetchMock = cloudSilentThen(async (url: string) =>
      isBitails(url)
        ? new Response('', { status: 404 })
        : new Response('{}', { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(txExistsOnChain(TXID, 'main')).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('treats a WhatsOnChain 429 as no evidence, not absence', async () => {
    vi.stubGlobal(
      'fetch',
      cloudSilentThen(async (url: string) =>
        isBitails(url)
          ? new Response('', { status: 500 })
          : new Response('', { status: 429 }),
      ),
    )
    await expect(txExistsOnChain(TXID, 'main')).resolves.toBeNull()
  })

  it('stops asking WhatsOnChain after it throttles us', async () => {
    const fetchMock = cloudSilentThen(async (url: string) =>
      isBitails(url)
        ? new Response('', { status: 500 })
        : new Response('', { status: 429 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await txExistsOnChain(TXID, 'main')
    await txExistsOnChain('cd'.repeat(32), 'main')

    const wocCalls = fetchMock.mock.calls.filter(([url]) => !isBitails(url) && !isCloud(url))
    expect(wocCalls).toHaveLength(1)
  })

  it('keeps a Bitails answer usable while WhatsOnChain is cooling down', async () => {
    let wocSeen = 0
    vi.stubGlobal(
      'fetch',
      cloudSilentThen(async (url: string) => {
        if (isBitails(url)) return new Response('{}', { status: 200 })
        wocSeen += 1
        return new Response('', { status: 429 })
      }),
    )

    await expect(txExistsOnChain(TXID, 'main')).resolves.toBe(true)
    await expect(txExistsOnChain('cd'.repeat(32), 'main')).resolves.toBe(true)
    expect(wocSeen).toBe(0)
  })

  it('rejects a malformed txid without any network call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(txExistsOnChain('nope', 'main')).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
