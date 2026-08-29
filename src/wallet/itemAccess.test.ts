import { describe, expect, it } from 'vitest'
import {
  isBsv21SpendArgs,
  isColourBasket,
  isColourIssuanceArgs,
  isItemBasket,
  isItemIssuanceArgs,
  isItemSpendArgs,
  isThirdPartyOriginator,
  isTokenViewBasket,
  isUnsupportedPBasket,
  itemViewGranted,
  mergeItemViewGrant,
  mergeTokenViewGrant,
  normalizeItemAccess,
  outputMatchesItemAccess,
  outputMatchesTokenAccess,
  parseItemViewRequest,
  parsePBasket,
  parseTokenViewRequest,
  p1SatSpendIds,
  prepareItemBasketArgs,
  stampBrc164Id,
  tokenViewGranted,
  grantableCollectionIdsFromOutputs,
  grantableTokensFromOutputs,
  shouldRefuseColourList,
  DEFAULT_ITEM_ACCESS,
  DEFAULT_TOKEN_ACCESS,
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

  it('recognizes 1sat-ft mint as issuance', () => {
    const mint = {
      description: 'Mint GOLD',
      labels: ['1sat-ft', 'handcash-mint-1sat-ft'],
      outputs: [
        {
          lockingScript: '00',
          satoshis: 1,
          basket: '1sat-ft',
          tags: ['1sat-ft', 'ordinal'],
        },
        {
          lockingScript: '00',
          satoshis: 1,
          basket: '1sat-ft',
          tags: ['1sat-ft', 'ordinal'],
        },
      ],
    }
    expect(isColourIssuanceArgs('createAction', mint)).toBe(true)
  })

  it('recognizes BSV-21 basket transfers as token spends', () => {
    const send = {
      description: 'Send TST',
      labels: ['bsv21', 'handcash-send-token'],
      inputs: [{ outpoint: `${'ab'.repeat(32)}.0`, inputDescription: 'TST tip' }],
      outputs: [
        {
          lockingScript: '00',
          satoshis: 1,
          basket: 'bsv21',
          tags: ['bsv21', `bsv21:${'ab'.repeat(32)}_0`],
        },
      ],
    }
    expect(isBsv21SpendArgs('createAction', send)).toBe(true)
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

describe('third-party item and token view', () => {
  const allRequest = parseItemViewRequest({ basket: 'p 1sat all' })

  it('does not treat bsv21 as an item basket covered by 1sat all', () => {
    expect(isItemBasket('bsv21')).toBe(false)
    expect(isItemBasket('p bsv21 all')).toBe(false)
    expect(isTokenViewBasket('bsv21')).toBe(true)
    expect(isTokenViewBasket('p bsv21 all')).toBe(true)
    expect(isUnsupportedPBasket('p bsv21 all')).toBe(false)
    const itemAll = mergeItemViewGrant(DEFAULT_ITEM_ACCESS, allRequest)
    expect(itemAll.view).toBe('all')
    expect(
      tokenViewGranted(DEFAULT_TOKEN_ACCESS, parseTokenViewRequest({ basket: 'bsv21' })),
    ).toBe(false)
  })

  it('refuses view=all for third-party grants and keeps a filtered ceiling', () => {
    expect(isThirdPartyOriginator('market.handcash.io')).toBe(true)
    expect(isThirdPartyOriginator(undefined)).toBe(false)
    const access = mergeItemViewGrant(
      DEFAULT_ITEM_ACCESS,
      { ...allRequest, wantsAll: true, collections: ['alpha'] },
      { allowAll: false },
    )
    expect(access.view).toBe('filtered')
    expect(access.view).not.toBe('all')
    expect(access.collections).toEqual(['alpha'])
  })

  it('lets a filtered grant satisfy a later p 1sat all and filters results', () => {
    const access = mergeItemViewGrant(DEFAULT_ITEM_ACCESS, {
      scope: 'collection',
      collections: ['alpha'],
      apps: [],
      creators: [],
      ids: [],
      wantsAll: false,
    })
    expect(itemViewGranted(access, allRequest)).toBe(true)
    expect(
      outputMatchesItemAccess(access, ['collection:alpha', 'name:Ace'], undefined, allRequest),
    ).toBe(true)
    expect(
      outputMatchesItemAccess(access, ['collection:other', 'name:Zed'], undefined, allRequest),
    ).toBe(false)
    expect(
      outputMatchesItemAccess(access, ['1sat-ft', 'name:FOX'], undefined, allRequest),
    ).toBe(false)
  })

  it('returns empty colour lists for third parties', () => {
    expect(isColourBasket('1sat-ft')).toBe(true)
    expect(shouldRefuseColourList('market.handcash.io', '1sat-ft')).toBe(true)
    expect(shouldRefuseColourList(undefined, '1sat-ft')).toBe(false)
    expect(shouldRefuseColourList('market.handcash.io', '1sat')).toBe(false)
  })

  it('does not put 1sat-ft leftover or unnamed rows in the collection picker', () => {
    const { collections, apps } = grantableCollectionIdsFromOutputs([
      { tags: ['collection:alpha', 'name:Ace'] },
      { tags: ['1sat-ft', 'name:FOX'], customInstructions: JSON.stringify({ p: '1sat-ft' }) },
      { tags: [], customInstructions: JSON.stringify({ p: '1sat-ft', amt: '69000' }) },
      { tags: ['origin:aa.0'] },
    ])
    expect(collections).toEqual(['alpha'])
    expect(apps).toEqual([])
  })

  it('still hides leftover FOX when an old grant is view=all', () => {
    const access = { ...DEFAULT_ITEM_ACCESS, view: 'all' as const }
    expect(
      outputMatchesItemAccess(
        access,
        ['collection:fox', 'name:FOX'],
        JSON.stringify({ p: '1sat-ft', amt: '69000' }),
      ),
    ).toBe(false)
    expect(outputMatchesItemAccess(access, ['collection:alpha', 'name:Ace'])).toBe(true)
    expect(outputMatchesItemAccess(access, ['origin:aa.0'])).toBe(false)
  })

  it('grants only live 162 token ids, not leftover FOX', () => {
    const origin = `${'ab'.repeat(32)}_0`
    const tokens = grantableTokensFromOutputs([
      {
        tags: ['bsv21', `bsv21:${origin}`, 'sym:KING'],
        customInstructions: JSON.stringify({ p: 'bsv-20', id: origin, sym: 'KING', amt: '40' }),
      },
      {
        tags: ['1sat-ft', 'name:FOX'],
        customInstructions: JSON.stringify({ p: '1sat-ft', amt: '69000' }),
      },
    ])
    expect(tokens).toEqual([{ id: origin, ticker: 'KING' }])
    const access = mergeTokenViewGrant(
      DEFAULT_TOKEN_ACCESS,
      { scope: 'id', ids: [origin], wantsAll: false },
      { allowAll: false },
    )
    expect(access.view).toBe('filtered')
    const allTokens = parseTokenViewRequest({ basket: 'p bsv21 all' })
    expect(tokenViewGranted(access, allTokens)).toBe(true)
    expect(
      outputMatchesTokenAccess(access, ['bsv21', `bsv21:${origin}`], undefined, allTokens),
    ).toBe(true)
    expect(
      outputMatchesTokenAccess(access, ['bsv21', `bsv21:${'cd'.repeat(32)}_0`], undefined, allTokens),
    ).toBe(false)
  })
})
