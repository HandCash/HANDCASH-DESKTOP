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
})
