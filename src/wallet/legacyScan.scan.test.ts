/**
 * Provider selection for the address scan.
 *
 * The happy path must stay a single request — these hosts throttle us, which is
 * what the cooldown windows exist to survive. Only a stalled host earns a second.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetLegacyScanCooldownForTests, scanLegacyAddress } from './legacyScan'

/** Real mainnet P2PKH — the services provider locks it, so base58 must check out. */
const ADDRESS = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
const TXID = 'ab'.repeat(32)

const getUtxoStatus = vi.fn(async () => ({
  status: 'success',
  details: [{ txid: TXID, index: 2, satoshis: 700, height: 9 }],
}))

const wallet = () =>
  ({
    address: ADDRESS,
    chain: 'main',
    services: { getUtxoStatus },
  }) as never

const bitailsBody = (sats: number) =>
  JSON.stringify({ unspent: [{ txid: TXID, vout: 0, satoshis: sats, blockheight: 1 }] })

const wocBody = (sats: number) =>
  JSON.stringify([{ tx_hash: TXID, tx_pos: 1, value: sats, height: 2 }])

const isBitails = (url: unknown) => String(url).includes('bitails')
const isCloud = (url: unknown) => String(url).includes('/v1/chain/')

/** HandCash Chain probe/scan routes — tests skip unless they mock a definitive answer. */
function cloudSilent(
  next: (url: string) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    if (isCloud(url)) return new Response('', { status: 503 })
    return next(url)
  })
}

beforeEach(() => {
  resetLegacyScanCooldownForTests()
  getUtxoStatus.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetLegacyScanCooldownForTests()
})

describe('scanLegacyAddress', () => {
  it('answers from Bitails alone — no hedge request on the happy path', async () => {
    const fetchMock = cloudSilent(async (url: string) => {
      if (!isBitails(url)) throw new Error(`unexpected host ${url}`)
      return new Response(bitailsBody(500), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const scan = await scanLegacyAddress(wallet())

    expect(scan.source).toBe('bitails')
    expect(scan.sats).toBe(500)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(getUtxoStatus).not.toHaveBeenCalled()
  })

  it('promotes WhatsOnChain immediately when Bitails fails fast', async () => {
    const started = Date.now()
    vi.stubGlobal(
      'fetch',
      cloudSilent(async (url: string) => {
        if (isBitails(url)) throw new Error('bitails down')
        return new Response(wocBody(300), { status: 200 })
      }),
    )

    const scan = await scanLegacyAddress(wallet())

    expect(scan.source).toBe('whatsonchain')
    expect(scan.sats).toBe(300)
    // Must not sit out the stagger behind a host that already gave up.
    expect(Date.now() - started).toBeLessThan(600)
  })

  it('hedges to WhatsOnChain when Bitails stalls, and takes the first answer', async () => {
    vi.stubGlobal(
      'fetch',
      cloudSilent(async (url: string) => {
        if (isBitails(url)) {
          await new Promise((r) => setTimeout(r, 5_000))
          return new Response(bitailsBody(999), { status: 200 })
        }
        return new Response(wocBody(300), { status: 200 })
      }),
    )

    vi.useFakeTimers()
    try {
      const pending = scanLegacyAddress(wallet())
      await vi.advanceTimersByTimeAsync(1_300)
      const scan = await pending
      expect(scan.source).toBe('whatsonchain')
      expect(scan.sats).toBe(300)
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls through to toolbox services when both REST hosts fail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )

    const scan = await scanLegacyAddress(wallet())

    expect(scan.source).toBe('services')
    expect(scan.sats).toBe(700)
    expect(getUtxoStatus).toHaveBeenCalledTimes(1)
  })

  it('rejects when every provider fails', async () => {
    getUtxoStatus.mockRejectedValueOnce(new Error('services down') as never)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )

    await expect(scanLegacyAddress(wallet())).rejects.toThrow(/offline|services down/)
  })

  it('skips a host inside its cooldown window instead of paying the timeout again', async () => {
    const fetchMock = cloudSilent(async (url: string) => {
      if (isBitails(url)) throw new Error('bitails down')
      return new Response(wocBody(300), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await scanLegacyAddress(wallet())
    const afterFirst = fetchMock.mock.calls.length
    fetchMock.mockClear()

    const scan = await scanLegacyAddress(wallet())

    expect(afterFirst).toBe(3)
    expect(scan.source).toBe('whatsonchain')
    expect(fetchMock.mock.calls.some(([url]) => isBitails(url))).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('borrows missing sat amounts from services when WhatsOnChain omits them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (isBitails(url)) throw new Error('bitails down')
        return new Response(
          JSON.stringify([{ tx_hash: TXID, tx_pos: 2, value: 0, height: 2 }]),
          { status: 200 },
        )
      }),
    )

    const scan = await scanLegacyAddress(wallet())

    expect(scan.source).toBe('whatsonchain')
    expect(scan.sats).toBe(700)
    expect(getUtxoStatus).toHaveBeenCalledTimes(1)
  })

  it('refuses to scan while the wallet is locked', async () => {
    await expect(scanLegacyAddress(null)).rejects.toThrow(/locked/i)
  })
})
