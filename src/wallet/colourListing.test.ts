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


vi.mock('./tokenIconCache', () => ({
  getTokenIconDataUrl: () => undefined,
}))

vi.mock('./fungibles', () => ({
  forgetFungibleToken: vi.fn(),
}))

const ORIGIN = `${'ab'.repeat(32)}_0`
const LEFTOVER = `${'cd'.repeat(32)}_1`
const KING_ORIGIN =
  '9c385c416f708fad7627db3dc2ab4f8b28acca7062dfb2dfe56db20e5f961ac4_0'
const SPENT_CHANGE =
  '2a562450e7b7009e01f6924376f4081ccf43a46487a1fd06a3a975935c7dda19_1'
const LIVE_CHANGE = `46fe5d93${'aa'.repeat(28)}_1`
const RECEIVE_A = `11${'bb'.repeat(31)}_0`
const RECEIVE_B = `22${'cc'.repeat(31)}_0`

function kingCi(amt: number, origin = KING_ORIGIN) {
  return JSON.stringify({
    p: '1sat-ft',
    origin,
    amt: String(amt),
    sym: 'KING',
    supply: 'locked',
    max: '69420',
  })
}

function receiveRow(outpoint: string, amt: number, origin = KING_ORIGIN) {
  return {
    outpoint,
    satoshis: 1,
    tags: ['1sat-ft', `origin:${origin}`],
    customInstructions: kingCi(amt, origin),
  }
}

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

  it('leftover-only tip → balance when mint absent', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.rememberOnesatFtLeftover({
      origin: ORIGIN,
      amt: 68862,
      outpoint: LEFTOVER,
      ci: kingCi(68862, ORIGIN),
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    const { listColourTokens } = await import('./colourListing')
    const tokens = await listColourTokens(mockWallet({ '1sat-ft': [], default: [] }))
    const row = tokens.find((x) => x.origin === ORIGIN)
    expect(row).toBeTruthy()
    expect(row!.balance).toBe(68862)
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
            customInstructions: kingCi(69420, ORIGIN),
          },
        ],
        default: [],
      }),
    )
    expect(tokens.filter((x) => x.origin === ORIGIN)).toHaveLength(0)
    expect(tokens.find((x) => x.origin === KING_ORIGIN)).toBeUndefined()
  })

  it('overlays leftover remittance onto bare P2PKH change so amt is visible', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.rememberOnesatFtLeftover({
      origin: ORIGIN,
      amt: 68862,
      outpoint: LEFTOVER,
      ci: kingCi(68862, ORIGIN),
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
    expect(row!.balance).toBe(68862)
    expect(row!.outpoint).toBe(LEFTOVER)
  })

  it('does not seed hardcoded leftover when listOutputs is empty', async () => {
    const { listColourTokens } = await import('./colourListing')
    const tokens = await listColourTokens(mockWallet({ '1sat-ft': [], default: [] }))
    expect(tokens).toHaveLength(0)
  })

  it('sums two 69 receives + leftover change 68862 = 69000', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.rememberOnesatFtLeftover({
      origin: KING_ORIGIN,
      amt: 68862,
      outpoint: LIVE_CHANGE,
      ci: kingCi(68862),
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    leftover.rememberOnesatFtLeftover({
      origin: KING_ORIGIN,
      amt: 68931,
      outpoint: SPENT_CHANGE,
      ci: kingCi(68931),
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    const { markItemsSent } = await import('./sentItemGuard')
    markItemsSent([SPENT_CHANGE])
    leftover.healOnesatFtFromListed([])
    const { listColourTokens } = await import('./colourListing')
    const tokens = await listColourTokens(
      mockWallet({
        '1sat-ft': [
          receiveRow(RECEIVE_A.replace('_0', '.0'), 69),
          receiveRow(RECEIVE_B.replace('_0', '.0'), 69),
        ],
        default: [],
      }),
    )
    const kings = tokens.filter((x) => x.origin === KING_ORIGIN)
    expect(kings).toHaveLength(1)
    expect(kings[0]!.balance).toBe(69000)
    expect(kings[0]!.tipCount).toBe(3)
    expect(kings[0]!.sym).toBe('KING')
    expect(leftover.leftoverForOutpoint(SPENT_CHANGE)).toBeNull()
    expect(leftover.leftoverForOutpoint(LIVE_CHANGE)?.amt).toBe(68862)
  })

  it('does not skip leftover change just because a receive of the same origin is listed', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.rememberOnesatFtLeftover({
      origin: KING_ORIGIN,
      amt: 68862,
      outpoint: LIVE_CHANGE,
      ci: kingCi(68862),
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    const { listColourTokens } = await import('./colourListing')
    const tokens = await listColourTokens(
      mockWallet({
        '1sat-ft': [receiveRow(RECEIVE_A.replace('_0', '.0'), 69)],
        default: [],
      }),
    )
    const kings = tokens.filter((x) => x.origin === KING_ORIGIN)
    expect(kings).toHaveLength(1)
    expect(kings[0]!.balance).toBe(68931)
  })

  it('does not overlay leftover change when that outpoint is already listed', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.rememberOnesatFtLeftover({
      origin: KING_ORIGIN,
      amt: 68862,
      outpoint: LIVE_CHANGE,
      ci: kingCi(68862),
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    const { listColourTokens } = await import('./colourListing')
    const tokens = await listColourTokens(
      mockWallet({
        '1sat-ft': [
          receiveRow(RECEIVE_A.replace('_0', '.0'), 69),
          receiveRow(RECEIVE_B.replace('_0', '.0'), 69),
          {
            outpoint: LIVE_CHANGE.replace('_1', '.1'),
            satoshis: 1,
            tags: ['1sat-ft', `origin:${KING_ORIGIN}`],
            customInstructions: kingCi(68862),
          },
        ],
        default: [],
      }),
    )
    const kings = tokens.filter((x) => x.origin === KING_ORIGIN)
    expect(kings).toHaveLength(1)
    expect(kings[0]!.balance).toBe(69000)
    expect(kings[0]!.balance).not.toBe(137862)
    expect(kings[0]!.tipCount).toBe(3)
  })

  it('keeps listed 1-sat with leftover remittance even without 1sat-ft CI', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.rememberOnesatFtLeftover({
      origin: KING_ORIGIN,
      amt: 68862,
      outpoint: LIVE_CHANGE,
      ci: kingCi(68862),
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    const { listColourTokens } = await import('./colourListing')
    const tokens = await listColourTokens(
      mockWallet({
        '1sat-ft': [
          receiveRow(RECEIVE_A.replace('_0', '.0'), 69),
          receiveRow(RECEIVE_B.replace('_0', '.0'), 69),
        ],
        default: [
          {
            outpoint: LIVE_CHANGE.replace('_1', '.1'),
            satoshis: 1,
            tags: [],
            lockingScript: '76a914459c25bcd929e76cb825ef2185e31409f5d5f96a88ac',
          },
        ],
      }),
    )
    const kings = tokens.filter((x) => x.origin === KING_ORIGIN)
    expect(kings).toHaveLength(1)
    expect(kings[0]!.balance).toBe(69000)
    expect(kings[0]!.tipCount).toBe(3)
  })
})
