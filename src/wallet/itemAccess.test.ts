import { describe, expect, it } from 'vitest'
import {
  isItemBasket,
  isItemIssuanceArgs,
  isItemSpendArgs,
  isUnsupportedPBasket,
  itemViewGranted,
  mergeItemViewGrant,
  normalizeItemAccess,
  outputMatchesItemAccess,
  parseItemViewRequest,
  parsePBasket,
  p1SatSpendIds,
  prepareItemBasketArgs,
  stampBrc164Id,
  DEFAULT_ITEM_ACCESS,
} from './itemAccess'

describe('BRC-99 p 1sat baskets', () => {
  it('parses the scheme and fixed scope token', () => {
    expect(parsePBasket('p 1sat all')).toEqual({ scheme: '1sat', rest: 'all' })
    expect(parsePBasket('p 1sat collection')).toEqual({
      scheme: '1sat',
      rest: 'collection',
    })
    expect(parsePBasket('p 1sat')).toEqual({ scheme: '1sat', rest: '' })
    expect(parsePBasket('1sat')).toBeNull()
  })

  it('recognizes plain storage and p 1sat permission baskets', () => {
    expect(isItemBasket('1sat')).toBe(true)
    expect(isItemBasket('p 1sat all')).toBe(true)
    expect(isItemBasket('p 1sat collection')).toBe(true)
    expect(isItemBasket('default')).toBe(false)
  })

  it('rejects unsupported p schemes', () => {
    expect(isUnsupportedPBasket('p dollarToken x')).toBe(true)
    expect(isUnsupportedPBasket('p 1sat all')).toBe(false)
    expect(isUnsupportedPBasket('1sat')).toBe(false)
  })

  it('parses scope values from ordinary tags without merging app and creator', () => {
    expect(parseItemViewRequest({ basket: 'p 1sat all' })).toEqual({
      scope: 'all',
      collections: [],
      apps: [],
      creators: [],
      ids: [],
      wantsAll: true,
    })
    expect(parseItemViewRequest({
      basket: 'p 1sat collection',
      tags: ['collection:c1'],
    })).toEqual({
      scope: 'collection',
      collections: ['c1'],
      apps: [],
      creators: [],
      ids: [],
      wantsAll: false,
    })
    expect(parseItemViewRequest({
      basket: 'p 1sat app',
      tags: ['app:wallet.example', 'creator:alice'],
    })).toEqual({
      scope: 'app',
      collections: [],
      apps: ['wallet.example'],
      creators: [],
      ids: [],
      wantsAll: false,
    })
    expect(parseItemViewRequest({
      basket: 'p 1sat creator',
      tags: ['app:wallet.example', 'creator:alice'],
    })).toEqual({
      scope: 'creator',
      collections: [],
      apps: [],
      creators: ['alice'],
      ids: [],
      wantsAll: false,
    })
  })

  it('rewrites p basket to storage 1sat without changing caller tags', () => {
    const prepared = prepareItemBasketArgs({
      basket: 'p 1sat collection',
      tags: ['collection:c1', 'type:image/png'],
    })
    expect(prepared.error).toBeUndefined()
    expect(prepared.args).toEqual({
      basket: '1sat',
      tags: ['collection:c1', 'type:image/png'],
      includeTags: true,
    })
    expect(prepared.itemViewRequest?.scope).toBe('collection')
  })

  it.each([
    ['p 1sat', [], 'INVALID_P1SAT_SCOPE'],
    ['p 1sat *', [], 'INVALID_P1SAT_SCOPE'],
    ['p 1sat collection:c1', [], 'INVALID_P1SAT_SCOPE'],
    ['p 1sat unknown', [], 'INVALID_P1SAT_SCOPE'],
    ['p 1sat collection', [], 'MISSING_P1SAT_SCOPE_TAG'],
    ['p 1sat app', ['creator:alice'], 'MISSING_P1SAT_SCOPE_TAG'],
  ])('fails closed for invalid request %s', (basket, tags, code) => {
    expect(prepareItemBasketArgs({ basket, tags }).error?.code).toBe(code)
  })

  it('errors on unsupported p schemes', () => {
    expect(prepareItemBasketArgs({ basket: 'p other foo' }).error?.code)
      .toBe('UNSUPPORTED_P_BASKET')
  })

  it('keeps app and creator grants distinct when filtering outputs', () => {
    const access = mergeItemViewGrant(DEFAULT_ITEM_ACCESS, {
      scope: 'app',
      collections: [],
      apps: ['wallet.example'],
      creators: [],
      ids: [],
      wantsAll: false,
    })
    expect(access.view).toBe('filtered')
    expect(access.apps).toEqual(['wallet.example'])
    expect(access.creators).toEqual([])
    expect(
      itemViewGranted(access, {
        scope: 'app',
        collections: [],
        apps: ['wallet.example'],
        creators: [],
        ids: [],
        wantsAll: false,
      }),
    ).toBe(true)
    expect(
      outputMatchesItemAccess(access, ['app:wallet.example'], undefined, {
        scope: 'app',
        collections: [],
        apps: ['wallet.example'],
        creators: [],
        ids: [],
        wantsAll: false,
      }),
    ).toBe(true)
    expect(
      outputMatchesItemAccess(access, ['creator:wallet.example'], undefined, {
        scope: 'app',
        collections: [],
        apps: ['wallet.example'],
        creators: [],
        ids: [],
        wantsAll: false,
      }),
    ).toBe(false)
  })

  it('supports narrow id-scoped grants and response filtering', () => {
    const request = parseItemViewRequest({
      basket: 'p 1sat id',
      tags: ['id:row-1'],
    })
    const access = mergeItemViewGrant(DEFAULT_ITEM_ACCESS, request)
    expect(itemViewGranted(access, request)).toBe(true)
    expect(outputMatchesItemAccess(access, ['id:row-1'], undefined, request)).toBe(true)
    expect(outputMatchesItemAccess(access, ['id:row-2'], undefined, request)).toBe(false)
  })

  it('normalizes new grant axes on existing stored access', () => {
    expect(normalizeItemAccess({ view: 'all', canSend: true })).toMatchObject({
      view: 'all',
      apps: [],
      creators: [],
      ids: [],
    })
  })

  it('stamps a stable BRC-164 id without replacing a writer-supplied key', () => {
    const stamped = stampBrc164Id(['ordinal'])
    expect(stamped).toHaveLength(2)
    expect(stamped[1]).toMatch(/^id:[0-9a-f]{32}$/)
    expect(stampBrc164Id(['ordinal', 'id:held-row'])).toEqual([
      'ordinal',
      'id:held-row',
    ])
  })

  it('stamps item outputs and basket insertion remittances', () => {
    const prepared = prepareItemBasketArgs({
      outputs: [
        { basket: '1sat', tags: ['ordinal'] },
        {
          protocol: 'basket insertion',
          insertionRemittance: { basket: '1sat', tags: ['ordinal'] },
        },
      ],
    })
    const outputs = (prepared.args as { outputs: Array<Record<string, unknown>> }).outputs
    expect(outputs[0]?.tags).toEqual([
      'ordinal',
      expect.stringMatching(/^id:[0-9a-f]{32}$/),
    ])
    expect((outputs[1]?.insertionRemittance as { tags: string[] }).tags).toEqual([
      'ordinal',
      expect.stringMatching(/^id:[0-9a-f]{32}$/),
    ])
  })
})

describe('telling an item mint from an item send', () => {
  const mint = {
    description: 'Mint Studio Item',
    labels: ['1sat', 'handcash-mint-studio', 'item'],
    outputs: [
      {
        lockingScript: '00',
        satoshis: 1,
        basket: '1sat',
        tags: ['name:Studio Item', 'app:mint-studio'],
      },
    ],
  }

  it('reads a fresh inscription as issuance', () => {
    expect(isItemIssuanceArgs('createAction', mint)).toBe(true)
    // Still an item action: never covered by Pay or Auto-pay.
    expect(isItemSpendArgs('createAction', mint)).toBe(true)
  })

  it('recognizes the BRC-165 held-row spend label', () => {
    const args = {
      labels: ['p 1sat input id row-1'],
      inputs: [{ outpoint: `${'ab'.repeat(32)}.0` }],
    }
    expect(p1SatSpendIds(args)).toEqual(['row-1'])
    expect(isItemSpendArgs('createAction', args)).toBe(true)
  })

  it('refuses issuance once a tip is being spent', () => {
    const send = {
      ...mint,
      inputs: [{ outpoint: `${'ab'.repeat(32)}.0`, inputDescription: '1sat tip' }],
    }
    expect(isItemIssuanceArgs('createAction', send)).toBe(false)
    expect(isItemSpendArgs('createAction', send)).toBe(true)
  })

  it('leaves plain payments and signAction alone', () => {
    expect(isItemIssuanceArgs('signAction', mint)).toBe(false)
    expect(
      isItemIssuanceArgs('createAction', {
        description: 'Pay',
        outputs: [{ lockingScript: '00', satoshis: 5000 }],
      }),
    ).toBe(false)
  })
})
