import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

vi.mock('./sentItemGuard', () => ({
  isItemSent: () => false,
  markItemsConsumed: vi.fn(),
}))

const ORIGIN = `${'ab'.repeat(32)}_0`
const LEFTOVER = `${'cd'.repeat(32)}_1`
const KING_ORIGIN =
  '9c385c416f708fad7627db3dc2ab4f8b28acca7062dfb2dfe56db20e5f961ac4_0'
const LIVE_CHANGE = `46fe5d93${'aa'.repeat(28)}_1`
const RECEIVE_A = `11${'bb'.repeat(31)}_0`

function row(opts: { tokenId: string; amt: string; outpoint: string }) {
  return {
    tokenId: opts.tokenId,
    sym: 'KING',
    amt: opts.amt,
    dec: 0,
    utxoCount: 1,
    outpoint: opts.outpoint,
    spendKind: 'plain' as const,
    colourSupply: 'locked' as const,
    colourMaxSupply: 69420,
    colourProvenanceOk: true,
  }
}

describe('mergeLiveFungibles', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('drops a genesis cache extra absent from live even if not yet marked spent', async () => {
    const { mergeLiveFungibles } = await import('./token/list')
    const prior = [row({ tokenId: ORIGIN, amt: '69420', outpoint: ORIGIN })]
    const merged = mergeLiveFungibles([], prior)
    expect(merged).toHaveLength(0)
  })

  it('uses live aggregated amt — leftover 68862 + live 69000 is 69000 not 137862', async () => {
    const { mergeLiveFungibles } = await import('./token/list')
    const prior = [
      row({
        tokenId: KING_ORIGIN,
        amt: '68862',
        outpoint: LIVE_CHANGE,
      }),
    ]
    const live = [
      row({
        tokenId: KING_ORIGIN,
        amt: '69000',
        outpoint: RECEIVE_A,
      }),
    ]
    const merged = mergeLiveFungibles(live, prior)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.amt).toBe('69000')
    expect(merged[0]!.amt).not.toBe('137862')
    expect(merged[0]!.tokenId).toBe(KING_ORIGIN)
  })

  it('second merge of leftover 68862 + live 69000 stays 69000', async () => {
    const { mergeLiveFungibles } = await import('./token/list')
    const prior = [
      row({
        tokenId: KING_ORIGIN,
        amt: '68862',
        outpoint: LIVE_CHANGE,
      }),
    ]
    const live = [
      row({
        tokenId: KING_ORIGIN,
        amt: '69000',
        outpoint: RECEIVE_A,
      }),
    ]
    const once = mergeLiveFungibles(live, prior)
    const twice = mergeLiveFungibles(live, once)
    expect(once).toHaveLength(1)
    expect(once[0]!.amt).toBe('69000')
    expect(twice).toHaveLength(1)
    expect(twice[0]!.amt).toBe('69000')
  })

  it('live listing aggregate wins over a smaller same-outpoint prior leftover', async () => {
    const { mergeLiveFungibles } = await import('./token/list')
    const prior = [
      row({
        tokenId: KING_ORIGIN,
        amt: '68862',
        outpoint: LIVE_CHANGE,
      }),
    ]
    const live = [
      row({
        tokenId: KING_ORIGIN,
        amt: '69000',
        outpoint: LIVE_CHANGE,
      }),
    ]
    const merged = mergeLiveFungibles(live, prior)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.amt).toBe('69000')
    expect(merged[0]!.outpoint).toBe(LIVE_CHANGE)
  })

  it('preserves prior icon when live listing lacks it', async () => {
    const { mergeLiveFungibles } = await import('./token/list')
    const prior = [
      {
        ...row({
          tokenId: KING_ORIGIN,
          amt: '68862',
          outpoint: LIVE_CHANGE,
        }),
        icon: 'icon-op',
        iconUrl: 'data:image/png;base64,xx',
      },
    ]
    const live = [
      row({
        tokenId: KING_ORIGIN,
        amt: '69000',
        outpoint: RECEIVE_A,
      }),
    ]
    const merged = mergeLiveFungibles(live, prior)
    expect(merged[0]!.amt).toBe('69000')
    expect(merged[0]!.icon).toBe('icon-op')
    expect(merged[0]!.iconUrl).toBe('data:image/png;base64,xx')
  })

  it('preserves a recovered ticker when live remittance only has a fallback label', async () => {
    const { mergeLiveFungibles } = await import('./token/list')
    const prior = [
      row({
        tokenId: KING_ORIGIN,
        amt: '240',
        outpoint: LIVE_CHANGE,
      }),
    ]
    const live = [
      {
        ...row({
          tokenId: KING_ORIGIN,
          amt: '240',
          outpoint: RECEIVE_A,
        }),
        sym: `${KING_ORIGIN.slice(0, 6)}…${KING_ORIGIN.slice(-4)}`,
      },
    ]

    const merged = mergeLiveFungibles(live, prior)
    expect(merged[0]!.sym).toBe('KING')
    expect(merged[0]!.amt).toBe('240')
  })

  it('removes a fully spent token from the immediate cache', async () => {
    const {
      getCachedFungibles,
      paintFungibleAfterSpend,
      rememberFungibleToken,
    } = await import('./token/list')
    rememberFungibleToken(row({
      tokenId: KING_ORIGIN,
      amt: '240',
      outpoint: LIVE_CHANGE,
    }))

    paintFungibleAfterSpend({
      tokenId: KING_ORIGIN,
      remainingAmt: 0n,
    })

    expect(getCachedFungibles()).toHaveLength(0)
  })

  it('keeps a real token whose ticker is Collectable', async () => {
    const { getCachedFungibles, rememberFungibleToken } = await import('./token/list')
    rememberFungibleToken({
      tokenId: KING_ORIGIN,
      sym: 'Collectable',
      amt: '11111111111',
      dec: 0,
      utxoCount: 1,
      outpoint: `${KING_ORIGIN.replace('_', '.')}`,
      spendKind: 'plain',
    })
    expect(getCachedFungibles()).toMatchObject([
      { tokenId: KING_ORIGIN, amt: '11111111111', sym: 'Collectable' },
    ])
  })

  it('paints exact BSV-21 change without converting large amounts to number', async () => {
    const {
      getCachedFungibles,
      paintFungibleAfterSpend,
      rememberFungibleToken,
    } = await import('./token/list')
    rememberFungibleToken(row({
      tokenId: KING_ORIGIN,
      amt: '900719925474099300',
      outpoint: LIVE_CHANGE,
    }))

    paintFungibleAfterSpend({
      tokenId: KING_ORIGIN,
      remainingAmt: 900719925474099299n,
      outpoint: RECEIVE_A,
      utxoCount: 2,
    })

    expect(getCachedFungibles()[0]).toMatchObject({
      amt: '900719925474099299',
      outpoint: RECEIVE_A,
      utxoCount: 2,
    })
  })

  it('lists a legacy JSON BSV-21 tip for the burn planner', async () => {
    const { listFungibleTips, rememberFungibleToken } = await import('./token/list')
    const icon = `${'5a'.repeat(32)}_1`
    const held = `${'e0'.repeat(32)}.0`
    rememberFungibleToken({
      ...row({ tokenId: KING_ORIGIN, amt: '240', outpoint: held }),
      icon,
    })
    const active = {
      identityKey: `02${'11'.repeat(32)}`,
      wallet: {
        listOutputs: async () => ({
          outputs: [
            {
              outpoint: held,
              satoshis: 1,
              lockingScript: `76a914${'22'.repeat(20)}88ac`,
              tags: ['bsv21', `bsv21:${KING_ORIGIN}`, 'amt:240'],
              customInstructions: JSON.stringify({
                p: 'bsv-20',
                op: 'transfer',
                id: KING_ORIGIN,
                amt: '240',
                sym: 'KING',
                icon,
              }),
            },
          ],
        }),
      },
    }

    await expect(
      listFungibleTips(active as never, { tokenIds: [KING_ORIGIN] }),
    ).resolves.toMatchObject([
      {
        outpoint: held,
        tokenId: KING_ORIGIN,
        amt: '240',
        sym: 'KING',
        icon,
      },
    ])
  })

  it('does not keep inflated prior 275586 over live 69000', async () => {
    const { mergeLiveFungibles } = await import('./token/list')
    const prior = [
      row({
        tokenId: KING_ORIGIN,
        amt: '275586',
        outpoint: RECEIVE_A,
      }),
    ]
    const live = [
      row({
        tokenId: KING_ORIGIN,
        amt: '69000',
        outpoint: RECEIVE_A,
      }),
    ]
    const merged = mergeLiveFungibles(live, prior)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.amt).toBe('69000')
    expect(merged[0]!.amt).not.toBe('275586')
  })

  it('leftover floor 68862 does not clobber a 69000 cache with more tips', async () => {
    const { leftoverFloorWouldClobber } = await import('./token/list')
    expect(
      leftoverFloorWouldClobber(
        { amt: '69000', utxoCount: 3 },
        { amt: '68862', utxoCount: 1 },
      ),
    ).toBe(true)
    expect(
      leftoverFloorWouldClobber(undefined, { amt: '68862', utxoCount: 1 }),
    ).toBe(false)
  })

  it('live 162 colourSupply wins over stale colourSupply-null legacy same tokenId', async () => {
    const { mergeLiveFungibles } = await import('./token/list')
    const tokenId = `${'5a'.repeat(32)}_0`
    const prior = [
      {
        tokenId,
        sym: 'GOLD',
        amt: '1',
        dec: 0,
        utxoCount: 1,
        outpoint: tokenId,
        spendKind: 'plain' as const,
      },
    ]
    const live = [
      {
        tokenId,
        sym: 'GOLD',
        amt: '69240',
        dec: 0,
        utxoCount: 1,
        outpoint: tokenId,
        spendKind: 'plain' as const,
        colourSupply: 'locked' as const,
        icon: `${'5a'.repeat(32)}_1`,
      },
    ]
    const merged = mergeLiveFungibles(live, prior)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.colourSupply).toBe('locked')
    expect(merged[0]!.amt).toBe('69240')
    expect(merged[0]!.icon).toBe(`${'5a'.repeat(32)}_1`)
  })
})
