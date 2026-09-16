import { describe, expect, it, vi } from 'vitest'
import {
  announceMarketSold,
  canonicalSoldContext,
  encodeSoldSubmission,
} from './marketSoldAnnounce'
import { chooseMarketSoldAnnouncePath } from './marketSettlementPath'
import { PUBLIC_BRC_CLOUD_ORIGIN } from './walletConfig'

const BUYER = `02${'ab'.repeat(32)}`

describe('chooseMarketSoldAnnouncePath', () => {
  it('announces with buyer context when the overlay host is known', () => {
    expect(
      chooseMarketSoldAnnouncePath({
        host: 'https://market.handcash.io/',
        topic: 'tm_1sat_market',
        buyerIdentityKey: BUYER.toUpperCase(),
        settlementBeefBytes: 120,
      }),
    ).toEqual({
      announce: 'overlaySubmit',
      host: 'https://market.handcash.io',
      topic: 'tm_1sat_market',
      buyerIdentityKey: BUYER,
    })
  })

  it('refuses with a named reason instead of a malformed submit', () => {
    const base = {
      host: 'https://market.handcash.io',
      topic: 'tm_1sat_market',
      buyerIdentityKey: BUYER,
      settlementBeefBytes: 120,
    }
    expect(chooseMarketSoldAnnouncePath({ ...base, host: '  ' })).toEqual({
      announce: 'skip',
      reason: 'no-host',
    })
    expect(
      chooseMarketSoldAnnouncePath({ ...base, settlementBeefBytes: 0 }),
    ).toEqual({ announce: 'skip', reason: 'no-settlement-beef' })
    expect(
      chooseMarketSoldAnnouncePath({ ...base, buyerIdentityKey: 'nope' }),
    ).toEqual({ announce: 'skip', reason: 'buyer-identity-unknown' })
  })
})

describe('BRC-22 sold submission', () => {
  it('serializes context the way the overlay re-canonicalizes it', () => {
    expect(canonicalSoldContext({ b: '2', a: '1' })).toBe('{"a":"1","b":"2"}')
  })

  it('frames VarInt(BEEF length) || BEEF || canonical context', () => {
    const framed = encodeSoldSubmission([1, 2, 3], { buyerIdentityKey: BUYER })
    expect(framed[0]).toBe(3)
    expect(Array.from(framed.slice(1, 4))).toEqual([1, 2, 3])
    expect(new TextDecoder().decode(framed.slice(4))).toBe(
      `{"buyerIdentityKey":"${BUYER}"}`,
    )
  })

  it('uses a 0xfd VarInt once the BEEF exceeds 252 bytes', () => {
    const framed = encodeSoldSubmission(new Array(300).fill(7), {
      buyerIdentityKey: BUYER,
    })
    expect(Array.from(framed.slice(0, 3))).toEqual([0xfd, 300 & 0xff, 300 >>> 8])
  })
})

describe('announceMarketSold', () => {
  it('submits the settlement so the overlay de-lists the offer', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ kind: 'settled' }), { status: 200 }),
    )
    const result = await announceMarketSold(
      { settlementBeef: [1, 2, 3], buyerIdentityKey: BUYER },
      fetchImpl as unknown as typeof fetch,
    )
    expect(result).toEqual({ announced: true, kind: 'settled' })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    // Must be the BRC-22 host. `market.handcash.io/submit` 307s to HTML.
    expect(url).toBe(`${PUBLIC_BRC_CLOUD_ORIGIN}/submit`)
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/octet-stream',
      'X-Topics': '["tm_1sat_market"]',
      'x-includes-off-chain-values': 'true',
    })
  })

  it('treats a 409 as already de-listed', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'duplicate' }), { status: 409 }),
    )
    await expect(
      announceMarketSold(
        { settlementBeef: [1], buyerIdentityKey: BUYER },
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toEqual({ announced: true, kind: null })
  })

  it('never throws when the overlay is unreachable — the sale already settled', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline')
    })
    await expect(
      announceMarketSold(
        { settlementBeef: [1], buyerIdentityKey: BUYER },
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toEqual({ announced: false, reason: 'offline' })
  })

  it('does not submit at all without a usable buyer identity', async () => {
    const fetchImpl = vi.fn()
    await expect(
      announceMarketSold(
        { settlementBeef: [1], buyerIdentityKey: '' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toEqual({ announced: false, reason: 'buyer-identity-unknown' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
