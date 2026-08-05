import { describe, expect, it } from 'vitest'
import {
  isItemBasket,
  isUnsupportedPBasket,
  itemViewGranted,
  mergeItemViewGrant,
  normalizeItemAccess,
  outputMatchesItemAccess,
  parseItemViewRequest,
  parsePBasket,
  prepareItemBasketArgs,
  DEFAULT_ITEM_ACCESS,
} from './itemAccess'

describe('BRC-99 p 1sat baskets', () => {
  it('parses scheme and scope', () => {
    expect(parsePBasket('p 1sat *')).toEqual({ scheme: '1sat', rest: '*' })
    expect(parsePBasket('p 1sat collection:alpha')).toEqual({
      scheme: '1sat',
      rest: 'collection:alpha',
    })
    expect(parsePBasket('p 1sat')).toEqual({ scheme: '1sat', rest: '*' })
    expect(parsePBasket('1sat')).toBeNull()
  })

  it('treats plain 1sat and p 1sat as item baskets', () => {
    expect(isItemBasket('1sat')).toBe(true)
    expect(isItemBasket('p 1sat *')).toBe(true)
    expect(isItemBasket('p 1sat collection:x')).toBe(true)
    expect(isItemBasket('default')).toBe(false)
  })

  it('rejects unsupported p schemes', () => {
    expect(isUnsupportedPBasket('p dollarToken x')).toBe(true)
    expect(isUnsupportedPBasket('p 1sat *')).toBe(false)
    expect(isUnsupportedPBasket('1sat')).toBe(false)
  })

  it('parses view scope from p basket', () => {
    expect(parseItemViewRequest({ basket: 'p 1sat *' })).toEqual({
      collections: [],
      creators: [],
      origins: [],
      wantsAll: true,
    })
    expect(parseItemViewRequest({ basket: 'p 1sat collection:c1' })).toEqual({
      collections: ['c1'],
      creators: [],
      origins: [],
      wantsAll: false,
    })
    expect(parseItemViewRequest({ basket: 'p 1sat creator:handcash' })).toEqual({
      collections: [],
      creators: ['handcash'],
      origins: [],
      wantsAll: false,
    })
    expect(
      parseItemViewRequest({ basket: 'p 1sat origin:ab_0' }),
    ).toEqual({
      collections: [],
      creators: [],
      origins: ['ab_0'],
      wantsAll: false,
    })
  })

  it('rewrites p basket to storage 1sat and merges tags', () => {
    const prepared = prepareItemBasketArgs({
      basket: 'p 1sat collection:c1',
      tags: ['keep'],
    })
    expect(prepared.error).toBeUndefined()
    expect(prepared.args).toEqual({
      basket: '1sat',
      tags: ['keep', 'collection:c1'],
    })
  })

  it('errors on unsupported p baskets', () => {
    const prepared = prepareItemBasketArgs({ basket: 'p other foo' })
    expect(prepared.error?.code).toBe('UNSUPPORTED_P_BASKET')
  })

  it('merges origin grants and filters outputs', () => {
    const access = mergeItemViewGrant(DEFAULT_ITEM_ACCESS, {
      collections: [],
      creators: [],
      origins: ['aa_0'],
      wantsAll: false,
    })
    expect(access.view).toBe('filtered')
    expect(access.origins).toEqual(['aa_0'])
    expect(
      itemViewGranted(access, {
        collections: [],
        creators: [],
        origins: ['aa_0'],
        wantsAll: false,
      }),
    ).toBe(true)
    expect(
      outputMatchesItemAccess(access, ['origin:aa_0']),
    ).toBe(true)
    expect(
      outputMatchesItemAccess(access, ['origin:bb_0']),
    ).toBe(false)
  })

  it('normalizes missing origins on stored access', () => {
    expect(normalizeItemAccess({ view: 'all', canSend: true })).toMatchObject({
      view: 'all',
      origins: [],
      canSend: true,
    })
  })
})
