import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
  },
}))

vi.mock('./session', () => ({
  getActiveWallet: () => null,
}))

const AUTH_KEY = 'handcash.market.listingAuthorizations.v2'
const TX = 'aa'.repeat(32)

describe('invalidateMarketListingsForSpentOutpoints', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('cancels active auth when spent tip is dotted (markItemsSent form)', async () => {
    const underscored = `${TX}_0`
    store.set(
      AUTH_KEY,
      JSON.stringify([
        {
          key: `${underscored}:nonce`,
          outpoint: underscored,
          nonce: 'nonce',
          seller: '02' + '11'.repeat(32),
          origin: `${TX}_0`,
          provenanceHash: 'ab'.repeat(32),
          priceSats: 10_000,
          state: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    )

    const { invalidateMarketListingsForSpentOutpoints, getMarketListingAuthorization } =
      await import('./marketListing')

    // Regression: normalizeOutpoint returns underscore keys; filtering on `.`
    // made this a no-op and left Collect showing Listed on spent tips.
    expect(
      invalidateMarketListingsForSpentOutpoints([`${TX}.0`], 'tip-spent'),
    ).toBe(1)

    const auth = getMarketListingAuthorization({ outpoint: `${TX}.0` })
    expect(auth?.state).toBe('cancelled')
    expect(auth?.reason).toBe('tip-spent')
  })

  it('cancels reserved auth and accepts underscore spent keys', async () => {
    const underscored = `${TX}_1`
    store.set(
      AUTH_KEY,
      JSON.stringify([
        {
          key: `${underscored}:n2`,
          outpoint: underscored,
          nonce: 'n2',
          seller: '02' + '11'.repeat(32),
          origin: `${TX}_0`,
          provenanceHash: 'cd'.repeat(32),
          priceSats: 5_000,
          state: 'reserved',
          createdAt: 1,
          updatedAt: 1,
          reservationUntil: Date.now() + 60_000,
        },
      ]),
    )

    const { invalidateMarketListingsForSpentOutpoints, getMarketListingAuthorization } =
      await import('./marketListing')

    expect(invalidateMarketListingsForSpentOutpoints([underscored])).toBe(1)
    expect(getMarketListingAuthorization({ outpoint: underscored })?.state).toBe(
      'cancelled',
    )
  })

  it('skips malformed tips without wiping the batch', async () => {
    const underscored = `${TX}_2`
    store.set(
      AUTH_KEY,
      JSON.stringify([
        {
          key: `${underscored}:n3`,
          outpoint: underscored,
          nonce: 'n3',
          seller: '02' + '11'.repeat(32),
          origin: `${TX}_0`,
          provenanceHash: 'ef'.repeat(32),
          priceSats: 1,
          state: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    )

    const { invalidateMarketListingsForSpentOutpoints, getMarketListingAuthorization } =
      await import('./marketListing')

    expect(
      invalidateMarketListingsForSpentOutpoints(['not-an-outpoint', `${TX}.2`]),
    ).toBe(1)
    expect(getMarketListingAuthorization({ outpoint: `${TX}.2` })?.state).toBe(
      'cancelled',
    )
  })
})
