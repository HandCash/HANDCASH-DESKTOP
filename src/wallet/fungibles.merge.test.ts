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

  it('does not paint a 1sat-ft leftover as a token', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.markOnesatFtGenesisSpent(ORIGIN)
    const { mergeLiveFungibles } = await import('./fungibles')
    const prior = [row({ tokenId: ORIGIN, amt: '68862', outpoint: LEFTOVER })]
    const live = [row({ tokenId: ORIGIN, amt: '69420', outpoint: ORIGIN })]
    const merged = mergeLiveFungibles(live, prior)
    expect(merged).toHaveLength(0)
  })

  it('drops a cache-only spent genesis when live has no leftover', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.markOnesatFtGenesisSpent(ORIGIN)
    const { mergeLiveFungibles } = await import('./fungibles')
    const prior = [row({ tokenId: ORIGIN, amt: '69420', outpoint: ORIGIN })]
    const merged = mergeLiveFungibles([], prior)
    expect(merged).toHaveLength(0)
  })

  it('drops a genesis cache extra absent from live even if not yet marked spent', async () => {
    const { mergeLiveFungibles } = await import('./fungibles')
    const prior = [row({ tokenId: ORIGIN, amt: '69420', outpoint: ORIGIN })]
    const merged = mergeLiveFungibles([], prior)
    expect(merged).toHaveLength(0)
  })

  it('uses live aggregated amt — leftover 68862 + live 69000 is 69000 not 137862', async () => {
    const { mergeLiveFungibles } = await import('./fungibles')
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
    const { mergeLiveFungibles } = await import('./fungibles')
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
    const { mergeLiveFungibles } = await import('./fungibles')
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
    const { mergeLiveFungibles } = await import('./fungibles')
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

  it('does not keep inflated prior 275586 over live 69000', async () => {
    const { mergeLiveFungibles } = await import('./fungibles')
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

  it('drops inflated cache-only KING when live is empty', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.markOnesatFtGenesisSpent(KING_ORIGIN)
    const { mergeLiveFungibles } = await import('./fungibles')
    const prior = [
      row({
        tokenId: KING_ORIGIN,
        amt: '206724',
        outpoint: LIVE_CHANGE,
      }),
    ]
    const merged = mergeLiveFungibles([], prior)
    expect(merged).toHaveLength(0)
  })
})

  it('leftover floor 68862 does not clobber a 69000 cache with more tips', async () => {
    const { leftoverFloorWouldClobber } = await import('./fungibles')
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
    const { mergeLiveFungibles } = await import('./fungibles')
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
