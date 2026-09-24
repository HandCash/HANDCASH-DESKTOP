import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  accountLocalKey,
  bindAccountLocalKeyScope,
} from './accountLocalKeys'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

vi.mock('./session', () => ({
  getActiveWallet: () => null,
}))

const AUTH_KEY_BASE = 'handcash.market.listingAuthorizations.v2'
const authKey = () => accountLocalKey(AUTH_KEY_BASE)
const TX = 'aa'.repeat(32)

describe('invalidateMarketListingsForSpentOutpoints', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('cancels active auth when spent tip is dotted (markItemsSent form)', async () => {
    const underscored = `${TX}_0`
    store.set(
      authKey(),
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
  }, 15_000)

  it('cancels reserved auth and accepts underscore spent keys', async () => {
    const underscored = `${TX}_1`
    store.set(
      authKey(),
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
      authKey(),
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

  it('keeps listing authorizations isolated across account rebinds', async () => {
    const underscored = `${TX}_3`
    const record = {
      key: `${underscored}:n4`,
      outpoint: underscored,
      nonce: 'n4',
      seller: '02' + '11'.repeat(32),
      origin: `${TX}_0`,
      provenanceHash: '12'.repeat(32),
      priceSats: 2_000,
      state: 'active',
      createdAt: 1,
      updatedAt: 1,
    }
    store.set(authKey(), JSON.stringify([record]))
    const market = await import('./marketListing')

    expect(market.getMarketListingAuthorization({ outpoint: underscored })).not.toBeNull()
    bindAccountLocalKeyScope({
      accountIndex: 1,
      identityKey: 'vitest-secondary-identity',
      chain: 'main',
    })
    market.rebindMarketListingForAccount()
    expect(market.getMarketListingAuthorization({ outpoint: underscored })).toBeNull()
    expect(store.has(authKey())).toBe(false)
  })
})
