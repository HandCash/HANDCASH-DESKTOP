import { PrivateKey } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildBsv21ValueLock } from './bsv21Send'

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

const ADDR = PrivateKey.fromRandom().toAddress()
const ORIGIN = `${'ab'.repeat(32)}_0`
const LEFTOVER = `${'cd'.repeat(32)}_1`
const TOKEN_A = `${'11'.repeat(32)}_0`
const KING_ORIGIN =
  '9c385c416f708fad7627db3dc2ab4f8b28acca7062dfb2dfe56db20e5f961ac4_0'

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

describe('listColourTips leftover / 1sat-ft', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('does not paint leftover-only 1sat-ft as Tokens', async () => {
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
    const tokens = await listColourTokens(mockWallet({ '1sat-ft': [], bsv21: [], default: [] }))
    expect(tokens).toHaveLength(0)
  })

  it('does not paint 1sat-ft basket rows as Tokens', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.rememberOnesatFtLeftover({
      origin: ORIGIN,
      amt: 69000,
      outpoint: LEFTOVER,
      ci: kingCi(69000, ORIGIN),
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    leftover.markOnesatFtGenesisSpent(ORIGIN)
    const { lockingScript } = buildOnesatFtTransferLockingScript({
      address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
      amt: 69000,
    })
    const { listColourTokens } = await import('./colourListing')
    const tokens = await listColourTokens(
      mockWallet({
        '1sat-ft': [
          {
            outpoint: LEFTOVER,
            satoshis: 1,
            tags: ['1sat-ft'],
            lockingScript,
            customInstructions: JSON.stringify({ p: '1sat-ft', amt: '69000' }),
          },
        ],
        bsv21: [],
        default: [],
      }),
    )
    expect(tokens).toHaveLength(0)
  })

  it('does not overlay leftover remittance onto bare P2PKH change', async () => {
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
        bsv21: [],
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
    expect(tokens).toHaveLength(0)
  })

  it('does not seed hardcoded leftover when listOutputs is empty', async () => {
    const { listColourTokens } = await import('./colourListing')
    const tokens = await listColourTokens(mockWallet({ '1sat-ft': [], bsv21: [], default: [] }))
    expect(tokens).toHaveLength(0)
  })

  it('does not sum 1sat-ft receives + leftover change as Tokens', async () => {
    const leftover = await import('./onesatFtLeftover')
    leftover.rememberOnesatFtLeftover({
      origin: KING_ORIGIN,
      amt: 68862,
      outpoint: `${'46'.repeat(32)}_1`,
      ci: kingCi(68862),
      sym: 'KING',
      supply: 'locked',
      maxSupply: 69420,
    })
    const { listColourTokens } = await import('./colourListing')
    const tokens = await listColourTokens(
      mockWallet({
        '1sat-ft': [
          receiveRow(`${'11'.repeat(32)}.0`, 69),
          receiveRow(`${'22'.repeat(32)}.0`, 69),
        ],
        bsv21: [],
        default: [],
      }),
    )
    expect(tokens).toHaveLength(0)
  })

  it('lists 162 value tips from basket bsv21', async () => {
    const lockingScript = buildBsv21ValueLock({
      tokenId: TOKEN_A,
      amount: 42n,
      address: ADDR,
    })
    const { listColourTokens } = await import('./colourListing')
    const tokens = await listColourTokens(
      mockWallet({
        bsv21: [
          {
            outpoint: `${'aa'.repeat(32)}.1`,
            satoshis: 1,
            tags: ['bsv21', `bsv21:${TOKEN_A}`, 'amt:42', 'sym:gold'],
            lockingScript,
            customInstructions: JSON.stringify({
              p: 'bsv-20',
              op: 'transfer',
              id: TOKEN_A,
              amt: '42',
              sym: 'GOLD',
            }),
          },
        ],
        '1sat-ft': [receiveRow(`${'11'.repeat(32)}.0`, 69)],
      }),
    )
    expect(tokens).toHaveLength(1)
    expect(tokens[0]!.origin).toBe(TOKEN_A)
    expect(tokens[0]!.balance).toBe(42)
    expect(tokens[0]!.sym).toBe('GOLD')
  })
})


describe('decodeListedBsv21Tip remittance-only', () => {
  it('refuses remittance-only 1-sat with no 162 binary', async () => {
    const { decodeListedBsv21Tip } = await import('./colourListing')
    const tokenId = `${'11'.repeat(32)}_0`
    expect(
      decodeListedBsv21Tip({
        outpoint: `${'aa'.repeat(32)}.1`,
        satoshis: 1,
        lockingScript: `76a914${'11'.repeat(20)}88ac`,
        tags: ['bsv21', `bsv21:${tokenId}`, 'amt:60'],
        customInstructions: JSON.stringify({
          p: 'bsv-20',
          op: 'transfer',
          id: tokenId,
          amt: '60',
        }),
      }),
    ).toBeNull()
  })
})

describe('162 payload icon is live not legacy', () => {
  it('decodeListedBsv21Tip with payload icon and no CI is locked with icon outpoint', async () => {
    const { encodeBsv21Binary } = await import('./bsv21Binary')
    const { decodeListedBsv21Tip } = await import('./colourListing')
    const deployOut = `${'aa'.repeat(32)}_0`
    const script = encodeBsv21Binary({
      amount: 50n,
      payload: { sym: 'GOLD', icon: Uint8Array.from([2, 0, 0, 0]) },
      rest: `76a914${'11'.repeat(20)}88ac`,
    }).toHex()
    const tip = decodeListedBsv21Tip({
      outpoint: deployOut.replace('_', '.'),
      satoshis: 1,
      lockingScript: script,
    })
    expect(tip?.colourSupply).toBe('locked')
    expect(tip?.icon).toBe(`${'aa'.repeat(32)}_2`)
    expect(tip?.sym).toBe('GOLD')
  })
})
