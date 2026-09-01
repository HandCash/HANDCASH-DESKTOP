import { describe, expect, it, vi } from 'vitest'
import type { ActivityEntry } from './appActivity'
import type { FungibleToken } from './bsv21'
import {
  attachMarketListingToToken,
  listActiveBsv21MarketListings,
  tokenMarketPriceHistory,
} from './tokenMarketView'

vi.mock('./marketListing', () => ({
  getMarketListingAuthorization: vi.fn(({ outpoint }: { outpoint: string }) => {
    const op = outpoint.replace('.', '_')
    if (op !== 'abc123_0') return null
    return {
      priceSats: 5000,
      state: 'active',
      outpoint: 'abc123_0',
      origin: 'deadbeef_1',
      listing: { assetType: 'bsv21', origin: 'deadbeef_1', amt: 100 },
    }
  }),
  listMarketListingAuthorizations: vi.fn(() => [
    {
      key: 'abc123_0:nonce',
      outpoint: 'abc123_0',
      nonce: 'nonce',
      seller: '02abc',
      origin: 'deadbeef_1',
      provenanceHash: 'hash',
      priceSats: 5000,
      state: 'active',
      createdAt: 1,
      updatedAt: 1,
      listing: { assetType: 'bsv21', origin: 'deadbeef_1', amt: 100 },
    },
  ]),
}))

const token: FungibleToken = {
  tokenId: 'deadbeef_1',
  sym: 'KING',
  amt: '100',
  dec: 0,
  utxoCount: 1,
  outpoint: 'abc123_0',
  spendKind: 'plain',
  colourSupply: 'locked',
}

describe('tokenMarketView', () => {
  it('attaches active listing to held token', () => {
    const next = attachMarketListingToToken(token)
    expect(next.marketListing?.priceSats).toBe(5000)
    expect(next.marketListing?.listAmt).toBe(100)
  })

  it('builds local price history from market-list activity', () => {
    const activity: ActivityEntry[] = [
      {
        id: '1',
        origin: 'deadbeef_1',
        sats: 5000,
        at: 1000,
        kind: 'spent',
        method: 'market-list',
        status: 'complete',
        note: 'Listed KING for 5,000 sats',
        item: { tokenId: 'deadbeef_1', name: 'KING' },
      },
      {
        id: '2',
        origin: 'deadbeef_1',
        sats: 7500,
        at: 2000,
        kind: 'spent',
        method: 'market-list',
        status: 'complete',
        note: 'Listed KING for 7,500 sats',
        item: { tokenId: 'deadbeef_1', name: 'KING' },
      },
    ]
    const points = tokenMarketPriceHistory('deadbeef_1', activity)
    expect(points).toEqual([
      { at: 1000, priceSats: 5000 },
      { at: 2000, priceSats: 7500 },
    ])
  })

  it('lists active BSV-21 market rows for held tokens', () => {
    const listed = attachMarketListingToToken(token)
    const rows = listActiveBsv21MarketListings([listed])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.sym).toBe('KING')
    expect(rows[0]?.listing.priceSats).toBe(5000)
  })
})
