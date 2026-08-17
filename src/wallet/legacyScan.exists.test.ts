import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetLegacyScanCooldownForTests, txExistsOnChain } from './legacyScan'

const TXID = 'ab'.repeat(32)

afterEach(() => {
  vi.unstubAllGlobals()
  resetLegacyScanCooldownForTests()
})

const isBitails = (url: unknown) => String(url).includes('bitails')

describe('txExistsOnChain', () => {
  it('asks both providers concurrently rather than one after the other', async () => {
    let bitailsStarted = false
    let wocStartedWhileBitailsOpen = false
    const fetchMock = vi.fn(async (url: string) => {
      if (isBitails(url)) {
        bitailsStarted = true
        await new Promise((r) => setTimeout(r, 40))
        bitailsStarted = false
        return new Response('', { status: 404 })
      }
      if (bitailsStarted) wocStartedWhileBitailsOpen = true
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(txExistsOnChain(TXID, 'main')).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(wocStartedWhileBitailsOpen).toBe(true)
  })

  it('affirms presence when either provider has seen the tx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        isBitails(url)
          ? new Response('', { status: 500 })
          : new Response('{}', { status: 200 }),
      ),
    )
    await expect(txExistsOnChain(TXID, 'main')).resolves.toBe(true)
  })

  it('reports absent only when a provider answered 404 and none affirmed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
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

  it('prefers a definitive hit over a 404 from the other host', async () => {
    // Bitails 404 while WoC has it in mempool — absence is not proof here.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        isBitails(url)
          ? new Response('', { status: 404 })
          : new Response('{}', { status: 200 }),
      ),
    )
    await expect(txExistsOnChain(TXID, 'main')).resolves.toBe(true)
  })

  it('treats a WhatsOnChain 429 as no evidence, not absence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        isBitails(url)
          ? new Response('', { status: 500 })
          : new Response('', { status: 429 }),
      ),
    )
    await expect(txExistsOnChain(TXID, 'main')).resolves.toBeNull()
  })

  it('stops asking WhatsOnChain after it throttles us', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      isBitails(url)
        ? new Response('', { status: 500 })
        : new Response('', { status: 429 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await txExistsOnChain(TXID, 'main')
    await txExistsOnChain('cd'.repeat(32), 'main')

    const wocCalls = fetchMock.mock.calls.filter(([url]) => !isBitails(url))
    expect(wocCalls).toHaveLength(1)
  })

  it('keeps a Bitails answer usable while WhatsOnChain is cooling down', async () => {
    let wocSeen = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (isBitails(url)) return new Response('{}', { status: 200 })
        wocSeen += 1
        return new Response('', { status: 429 })
      }),
    )

    await expect(txExistsOnChain(TXID, 'main')).resolves.toBe(true)
    await expect(txExistsOnChain('cd'.repeat(32), 'main')).resolves.toBe(true)
    expect(wocSeen).toBe(1)
  })

  it('rejects a malformed txid without any network call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(txExistsOnChain('nope', 'main')).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
