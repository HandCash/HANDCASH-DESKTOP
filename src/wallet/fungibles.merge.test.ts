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
    binarySupply: 'locked' as const,
    maxSupply: 69420,
    provenanceOk: true,
  }
}

describe('projectHeldFungibles', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  const aged = 1

  it('projects only what the read listed and files every aged tip it omitted', async () => {
    const { projectHeldFungibles } = await import('./token/list')
    const legacyGhost = {
      tokenId: `${'ef'.repeat(32)}_0`,
      sym: 'GHOST',
      amt: '12',
      dec: 0,
      utxoCount: 1,
      outpoint: `${'ef'.repeat(32)}.1`,
      spendKind: 'plain' as const,
      seenAt: aged,
    }
    const held = row({ tokenId: KING_ORIGIN, amt: '100', outpoint: LIVE_CHANGE })
    const cacheOnly = { ...row({ tokenId: ORIGIN, amt: '5', outpoint: LEFTOVER }), seenAt: aged }
    const { rows, departed } = projectHeldFungibles([held], [legacyGhost, cacheOnly])
    expect(rows.map((t) => t.tokenId)).toEqual([KING_ORIGIN])
    expect(departed.map((t) => t.outpoint).sort()).toEqual(
      [legacyGhost.outpoint, LEFTOVER].sort(),
    )
  })

  /** The old merge kept every card on an empty read and every BRC-162 card forever. */
  it('has no exemption for an empty read or a BRC-162 card', async () => {
    const { projectHeldFungibles } = await import('./token/list')
    const card = { ...row({ tokenId: ORIGIN, amt: '5', outpoint: LEFTOVER }), seenAt: aged }
    const { rows, departed } = projectHeldFungibles([], [card])
    expect(rows).toEqual([])
    expect(departed.map((t) => t.outpoint)).toEqual([LEFTOVER])
  })

  /**
   * A mint painted from its own createAction cannot be in the basket yet.
   * Retiring it on that read made a fresh mint flash and vanish.
   */
  it('keeps a just-painted tip the basket has not listed yet', async () => {
    const { projectHeldFungibles } = await import('./token/list')
    const fresh = { ...row({ tokenId: ORIGIN, amt: '69420', outpoint: ORIGIN }), seenAt: Date.now() }
    const live = [row({ tokenId: KING_ORIGIN, amt: '1', outpoint: RECEIVE_A })]
    for (const read of [[], live]) {
      const { rows, departed } = projectHeldFungibles(read, [fresh])
      expect(rows.some((t) => t.tokenId === ORIGIN)).toBe(true)
      expect(departed).toEqual([])
    }
  })

  /**
   * Every publish restamps a row, so judging a missing tip by its row's stamp
   * kept a spent tip of a multi-tip token inside the grace forever.
   */
  it('judges a missing tip by its own first paint, not its freshly stamped row', async () => {
    const { projectHeldFungibles } = await import('./token/list')
    const spent = `${'77'.repeat(32)}_2`
    const prior = {
      ...row({ tokenId: KING_ORIGIN, amt: '300', outpoint: RECEIVE_A }),
      utxoCount: 2,
      seenAt: Date.now(),
      heldTips: [
        { outpoint: RECEIVE_A, tokenId: KING_ORIGIN, amt: '100', op: 'transfer' as const, dec: 0, satoshis: 1, seenAt: aged },
        { outpoint: spent, tokenId: KING_ORIGIN, amt: '200', op: 'transfer' as const, dec: 0, satoshis: 1, seenAt: aged },
      ],
    }
    const live = [row({ tokenId: KING_ORIGIN, amt: '100', outpoint: RECEIVE_A })]
    const { rows, departed } = projectHeldFungibles(live, [prior])
    expect(rows[0]).toMatchObject({ amt: '100', utxoCount: 1 })
    expect(departed.map((t) => t.outpoint)).toEqual([spent])
  })

  it('carries a tip\'s first paint across reads', async () => {
    const { projectHeldFungibles } = await import('./token/list')
    const painted = 1_000
    const prior = [{ ...row({ tokenId: KING_ORIGIN, amt: '1', outpoint: RECEIVE_A }), seenAt: painted }]
    const live = [row({ tokenId: KING_ORIGIN, amt: '1', outpoint: RECEIVE_A })]
    const { rows } = projectHeldFungibles(live, prior)
    expect(rows[0]!.heldTips?.[0]?.seenAt).toBe(painted)
  })

  it('uses live aggregated amt — leftover 68862 + live 69000 is 69000 not 137862', async () => {
    const { projectHeldFungibles } = await import('./token/list')
    const prior = [row({ tokenId: KING_ORIGIN, amt: '68862', outpoint: LIVE_CHANGE })]
    const live = [row({ tokenId: KING_ORIGIN, amt: '69000', outpoint: RECEIVE_A })]
    const { rows } = projectHeldFungibles(live, prior)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.amt).toBe('69000')
    expect(rows[0]!.tokenId).toBe(KING_ORIGIN)
  })

  it('a second projection of leftover 68862 + live 69000 stays 69000', async () => {
    const { projectHeldFungibles } = await import('./token/list')
    const prior = [row({ tokenId: KING_ORIGIN, amt: '68862', outpoint: LIVE_CHANGE })]
    const live = [row({ tokenId: KING_ORIGIN, amt: '69000', outpoint: RECEIVE_A })]
    const once = projectHeldFungibles(live, prior).rows
    const twice = projectHeldFungibles(live, once).rows
    expect(once.map((t) => t.amt)).toEqual(['69000'])
    expect(twice.map((t) => t.amt)).toEqual(['69000'])
  })

  it('live listing aggregate wins over a smaller same-outpoint prior leftover', async () => {
    const { projectHeldFungibles } = await import('./token/list')
    const prior = [row({ tokenId: KING_ORIGIN, amt: '68862', outpoint: LIVE_CHANGE })]
    const live = [row({ tokenId: KING_ORIGIN, amt: '69000', outpoint: LIVE_CHANGE })]
    const { rows } = projectHeldFungibles(live, prior)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.amt).toBe('69000')
    expect(rows[0]!.outpoint).toBe(LIVE_CHANGE)
  })

  it('preserves prior icon when live listing lacks it', async () => {
    const { projectHeldFungibles } = await import('./token/list')
    const prior = [
      {
        ...row({ tokenId: KING_ORIGIN, amt: '68862', outpoint: LIVE_CHANGE }),
        icon: 'icon-op',
        iconUrl: 'data:image/png;base64,xx',
      },
    ]
    const live = [row({ tokenId: KING_ORIGIN, amt: '69000', outpoint: RECEIVE_A })]
    const { rows } = projectHeldFungibles(live, prior)
    expect(rows[0]!.amt).toBe('69000')
    expect(rows[0]!.icon).toBe('icon-op')
    expect(rows[0]!.iconUrl).toBe('data:image/png;base64,xx')
  })

  it('preserves a recovered ticker when live remittance only has a fallback label', async () => {
    const { projectHeldFungibles } = await import('./token/list')
    const prior = [row({ tokenId: KING_ORIGIN, amt: '240', outpoint: LIVE_CHANGE })]
    const live = [
      {
        ...row({ tokenId: KING_ORIGIN, amt: '240', outpoint: RECEIVE_A }),
        sym: `${KING_ORIGIN.slice(0, 6)}…${KING_ORIGIN.slice(-4)}`,
      },
    ]
    const { rows } = projectHeldFungibles(live, prior)
    expect(rows[0]!.sym).toBe('KING')
    expect(rows[0]!.amt).toBe('240')
  })

  it('does not keep inflated prior 275586 over live 69000', async () => {
    const { projectHeldFungibles } = await import('./token/list')
    const prior = [row({ tokenId: KING_ORIGIN, amt: '275586', outpoint: RECEIVE_A })]
    const live = [row({ tokenId: KING_ORIGIN, amt: '69000', outpoint: RECEIVE_A })]
    const { rows } = projectHeldFungibles(live, prior)
    expect(rows.map((t) => t.amt)).toEqual(['69000'])
  })

  it('live BRC-162 row wins over a stale legacy row with the same tokenId', async () => {
    const { projectHeldFungibles } = await import('./token/list')
    const tokenId = `${'5a'.repeat(32)}_0`
    const prior = [
      { tokenId, sym: 'GOLD', amt: '1', dec: 0, utxoCount: 1, outpoint: tokenId, spendKind: 'plain' as const },
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
        binarySupply: 'locked' as const,
        icon: `${'5a'.repeat(32)}_1`,
      },
    ]
    const { rows } = projectHeldFungibles(live, prior)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.binarySupply).toBe('locked')
    expect(rows[0]!.amt).toBe('69240')
    expect(rows[0]!.icon).toBe(`${'5a'.repeat(32)}_1`)
  })

  it('overlay adds tips without dropping anything the base holds', async () => {
    const { overlayFungibles } = await import('./token/list')
    const base = [{ ...row({ tokenId: ORIGIN, amt: '5', outpoint: LEFTOVER }), seenAt: aged }]
    const add = [row({ tokenId: KING_ORIGIN, amt: '1', outpoint: RECEIVE_A })]
    expect(overlayFungibles(add, base).map((t) => t.tokenId).sort()).toEqual(
      [KING_ORIGIN, ORIGIN].sort(),
    )
  })
})

describe('fungible cache paints', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
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
      heldTips: [
        {
          outpoint: RECEIVE_A,
          tokenId: KING_ORIGIN,
          amt: '900719925474099298',
          op: 'transfer',
          sym: 'KING',
          dec: 0,
          satoshis: 1,
          binarySupply: 'locked',
        },
        {
          outpoint: `${'ff'.repeat(32)}_0`,
          tokenId: KING_ORIGIN,
          amt: '1',
          op: 'transfer',
          sym: 'KING',
          dec: 0,
          satoshis: 1,
          binarySupply: 'locked',
        },
      ],
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

  it('adds distinct received tips and deduplicates a retried paint', async () => {
    const {
      getCachedFungibles,
      rememberFungibleToken,
    } = await import('./token/list')
    const first = row({
      tokenId: KING_ORIGIN,
      amt: '40',
      outpoint: RECEIVE_A,
    })
    const second = row({
      tokenId: KING_ORIGIN,
      amt: '2',
      outpoint: `${'22'.repeat(32)}_1`,
    })

    rememberFungibleToken(first)
    rememberFungibleToken(second)
    rememberFungibleToken(second)

    expect(getCachedFungibles()).toMatchObject([
      {
        tokenId: KING_ORIGIN,
        amt: '42',
        utxoCount: 2,
        tipOutpoints: [RECEIVE_A, `${'22'.repeat(32)}_1`].sort(),
      },
    ])
  })

  it('replaces the aggregate after a spend instead of double-counting change', async () => {
    const {
      getCachedFungibles,
      paintFungibleAfterSpend,
      rememberFungibleToken,
    } = await import('./token/list')
    rememberFungibleToken(row({
      tokenId: KING_ORIGIN,
      amt: '40',
      outpoint: RECEIVE_A,
    }))
    rememberFungibleToken(row({
      tokenId: KING_ORIGIN,
      amt: '2',
      outpoint: `${'22'.repeat(32)}_1`,
    }))

    paintFungibleAfterSpend({
      tokenId: KING_ORIGIN,
      remainingAmt: 35,
      outpoint: LIVE_CHANGE,
      sym: 'KING',
      binarySupply: 'locked',
    })

    expect(getCachedFungibles()).toMatchObject([
      {
        amt: '35',
        utxoCount: 1,
        outpoint: LIVE_CHANGE,
        tipOutpoints: [LIVE_CHANGE],
      },
    ])
  })
})
