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

  it('does not restore genesis mint amt over a leftover', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.markOnesatFtGenesisSpent(ORIGIN)
    const { mergeLiveFungibles } = await import('./fungibles')
    const prior = [row({ tokenId: ORIGIN, amt: '69000', outpoint: LEFTOVER })]
    const live = [row({ tokenId: ORIGIN, amt: '69420', outpoint: ORIGIN })]
    const merged = mergeLiveFungibles(live, prior)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.amt).toBe('69000')
    expect(merged[0]!.outpoint).toBe(LEFTOVER)
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

  it('uses live aggregated amt — leftover 68931 + live 69000 is 69000 not 137931', async () => {
    const leftover = await import('./onesatFtLeftover')
    const { mergeLiveFungibles } = await import('./fungibles')
    const prior = [
      row({
        tokenId: leftover.KING_ORIGIN,
        amt: '68931',
        outpoint: leftover.KING_CHANGE_OUTPOINT,
      }),
    ]
    const live = [
      row({
        tokenId: leftover.KING_ORIGIN,
        amt: '69000',
        outpoint: leftover.KING_RECEIVE_OUTPOINT,
      }),
    ]
    const merged = mergeLiveFungibles(live, prior)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.amt).toBe('69000')
    expect(merged[0]!.amt).not.toBe('137931')
    expect(merged[0]!.tokenId).toBe(leftover.KING_ORIGIN)
  })

  it('second merge of leftover 68931 + live 69000 stays 69000', async () => {
    const leftover = await import('./onesatFtLeftover')
    const { mergeLiveFungibles } = await import('./fungibles')
    const prior = [
      row({
        tokenId: leftover.KING_ORIGIN,
        amt: '68931',
        outpoint: leftover.KING_CHANGE_OUTPOINT,
      }),
    ]
    const live = [
      row({
        tokenId: leftover.KING_ORIGIN,
        amt: '69000',
        outpoint: leftover.KING_RECEIVE_OUTPOINT,
      }),
    ]
    const once = mergeLiveFungibles(live, prior)
    const twice = mergeLiveFungibles(live, once)
    expect(once).toHaveLength(1)
    expect(once[0]!.amt).toBe('69000')
    expect(twice).toHaveLength(1)
    expect(twice[0]!.amt).toBe('69000')
  })

  it('keeps leftover amt when live is a smaller same outpoint', async () => {
    const leftover = await import('./onesatFtLeftover')
    const { mergeLiveFungibles } = await import('./fungibles')
    const prior = [
      row({
        tokenId: leftover.KING_ORIGIN,
        amt: '68931',
        outpoint: leftover.KING_CHANGE_OUTPOINT,
      }),
    ]
    const live = [
      row({
        tokenId: leftover.KING_ORIGIN,
        amt: '1',
        outpoint: leftover.KING_CHANGE_OUTPOINT,
      }),
    ]
    const merged = mergeLiveFungibles(live, prior)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.amt).toBe('68931')
    expect(merged[0]!.outpoint).toBe(leftover.KING_CHANGE_OUTPOINT)
  })

  it('preserves prior icon when live listing lacks it', async () => {
    const leftover = await import('./onesatFtLeftover')
    const { mergeLiveFungibles } = await import('./fungibles')
    const prior = [
      {
        ...row({
          tokenId: leftover.KING_ORIGIN,
          amt: '68931',
          outpoint: leftover.KING_CHANGE_OUTPOINT,
        }),
        icon: 'icon-op',
        iconUrl: 'data:image/png;base64,xx',
      },
    ]
    const live = [
      row({
        tokenId: leftover.KING_ORIGIN,
        amt: '69000',
        outpoint: leftover.KING_RECEIVE_OUTPOINT,
      }),
    ]
    const merged = mergeLiveFungibles(live, prior)
    expect(merged[0]!.amt).toBe('69000')
    expect(merged[0]!.icon).toBe('icon-op')
    expect(merged[0]!.iconUrl).toBe('data:image/png;base64,xx')
  })

  it('does not keep inflated prior 275586 over live 69000', async () => {
    const leftover = await import('./onesatFtLeftover')
    const { mergeLiveFungibles } = await import('./fungibles')
    const prior = [
      row({
        tokenId: leftover.KING_ORIGIN,
        amt: '275586',
        outpoint: leftover.KING_RECEIVE_OUTPOINT,
      }),
    ]
    const live = [
      row({
        tokenId: leftover.KING_ORIGIN,
        amt: '69000',
        outpoint: leftover.KING_RECEIVE_OUTPOINT,
      }),
    ]
    const merged = mergeLiveFungibles(live, prior)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.amt).toBe('69000')
    expect(merged[0]!.amt).not.toBe('275586')
  })

  it('drops inflated cache-only KING when live is empty', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.markOnesatFtGenesisSpent(leftover.KING_ORIGIN)
    const { mergeLiveFungibles } = await import('./fungibles')
    const prior = [
      row({
        tokenId: leftover.KING_ORIGIN,
        amt: '206724',
        outpoint: leftover.KING_CHANGE_OUTPOINT,
      }),
    ]
    const merged = mergeLiveFungibles([], prior)
    expect(merged).toHaveLength(0)
  })
})
