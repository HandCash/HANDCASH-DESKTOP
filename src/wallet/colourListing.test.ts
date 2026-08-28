import { beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('./sentItemGuard', () => ({
  isItemSent: () => false,
}))

vi.mock('./tokenIconCache', () => ({
  getTokenIconDataUrl: () => undefined,
}))

vi.mock('./fungibles', () => ({
  forgetFungibleToken: vi.fn(),
}))

const ORIGIN = `${'ab'.repeat(32)}_0`
const LEFTOVER = `${'cd'.repeat(32)}_1`
const KING_CI = JSON.stringify({
  p: '1sat-ft',
  origin: ORIGIN,
  amt: '69000',
  sym: 'KING',
  supply: 'locked',
  max: '69420',
})

function mockWallet(byBasket: Record<string, Array<Record<string, unknown>>>) {
  return {
    wallet: {
      listOutputs: async (args: { basket?: string }) => ({
        outputs: byBasket[args.basket ?? ''] ?? [],
      }),
    },
  } as never
}

describe('listColourTips leftover / spent genesis', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('leftover-only tip → balance 69000 when mint absent', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.rememberOnesatFtLeftover({
      origin: ORIGIN,
      amt: 69000,
      outpoint: LEFTOVER,
      ci: KING_CI,
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    const { listColourTokens } = await import('./colourListing')
    const tokens = await listColourTokens(mockWallet({ '1sat-ft': [], default: [] }))
    const row = tokens.find((x) => x.origin === ORIGIN)
    expect(row).toBeTruthy()
    expect(row!.balance).toBe(69000)
    expect(row!.outpoint).toBe(LEFTOVER)
    expect(row!.sym).toBe('KING')
  })

  it('spent mint + no leftover → empty', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.markOnesatFtGenesisSpent(ORIGIN)
    const { listColourTokens } = await import('./colourListing')
    const tokens = await listColourTokens(
      mockWallet({
        '1sat-ft': [
          {
            outpoint: ORIGIN,
            satoshis: 1,
            tags: ['1sat-ft'],
            customInstructions: JSON.stringify({
              p: '1sat-ft',
              amt: '69420',
              sym: 'KING',
              supply: 'locked',
              max: '69420',
            }),
          },
        ],
        default: [],
      }),
    )
    const { KING_ORIGIN } = leftover
    expect(tokens.filter((x) => x.origin === ORIGIN)).toHaveLength(0)
    expect(tokens.find((x) => x.origin === KING_ORIGIN)?.balance).toBe(69000)
  })

  it('counts a held leftover bare P2PKH when leftover remittance has p:1sat-ft', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.rememberOnesatFtLeftover({
      origin: ORIGIN,
      amt: 69000,
      outpoint: LEFTOVER,
      ci: KING_CI,
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    leftover.markOnesatFtGenesisSpent(ORIGIN)
    const { listColourTokens } = await import('./colourListing')
    const tokens = await listColourTokens(
      mockWallet({
        '1sat-ft': [],
        default: [
          {
            outpoint: LEFTOVER.replace('_1', '.1'),
            satoshis: 1,
            tags: [],
            lockingScript: '76a914459c25bcd929e76cb825ef2185e31409f5d5f96a88ac',
          },
        ],
      }),
    )
    const row = tokens.find((x) => x.origin === ORIGIN)
    expect(row).toBeTruthy()
    expect(row!.balance).toBe(69000)
    expect(row!.outpoint).toBe(LEFTOVER)
  })

  it('seeds 9abe8bdb leftover even when listOutputs is empty', async () => {
    const { KING_ORIGIN, KING_LEFTOVER_OUTPOINT } = await import('./onesatFtLeftover')
    const { listColourTokens } = await import('./colourListing')
    const tokens = await listColourTokens(mockWallet({ '1sat-ft': [], default: [] }))
    expect(tokens).toHaveLength(1)
    expect(tokens[0]!.origin).toBe(KING_ORIGIN)
    expect(tokens[0]!.balance).toBe(69000)
    expect(tokens[0]!.outpoint).toBe(KING_LEFTOVER_OUTPOINT)
    expect(tokens[0]!.sym).toBe('KING')
    expect(tokens[0]!.maxSupply).toBe(69420)
  })

  it('seeds 9abe8bdb leftover when that 1-sat is still listed', async () => {
    const { KING_ORIGIN, KING_LEFTOVER_OUTPOINT } = await import('./onesatFtLeftover')
    const { listColourTokens } = await import('./colourListing')
    const tokens = await listColourTokens(
      mockWallet({
        '1sat-ft': [],
        default: [
          {
            outpoint: KING_LEFTOVER_OUTPOINT,
            satoshis: 1,
            lockingScript: '76a914459c25bcd929e76cb825ef2185e31409f5d5f96a88ac',
          },
        ],
      }),
    )
    expect(tokens).toHaveLength(1)
    expect(tokens[0]!.origin).toBe(KING_ORIGIN)
    expect(tokens[0]!.balance).toBe(69000)
    expect(tokens[0]!.outpoint).toBe(KING_LEFTOVER_OUTPOINT)
    expect(tokens[0]!.sym).toBe('KING')
    expect(tokens[0]!.maxSupply).toBe(69420)
  })
})
