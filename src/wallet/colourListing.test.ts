import { PrivateKey } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildBsv21ValueLock } from './token'

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

vi.mock('./token/icons/cache', () => ({
  getTokenIconDataUrl: () => undefined,
}))

vi.mock('./token/list', () => ({
  forgetFungibleToken: vi.fn(),
}))

const ADDR = PrivateKey.fromRandom().toAddress()
const TOKEN_A = `${'11'.repeat(32)}_0`

function mockWallet(byBasket: Record<string, Array<Record<string, unknown>>>) {
  return {
    wallet: {
      listOutputs: async (args: { basket?: string }) => ({
        outputs: byBasket[args.basket ?? ''] ?? [],
      }),
    },
  } as never
}

describe('BRC-162 token listing', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('lists 162 value tips from basket p2pft', async () => {
    const lockingScript = buildBsv21ValueLock({ layout: 'brc162',
      tokenId: TOKEN_A,
      amount: 42n,
      address: ADDR,
    })
    const { listBsv21BinaryTokens } = await import('./token/listTips')
    const tokens = await listBsv21BinaryTokens(
      mockWallet({
        p2pft: [
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
      }),
    )
    expect(tokens).toHaveLength(1)
    expect(tokens[0]!.tokenId).toBe(TOKEN_A)
    expect(tokens[0]!.amt).toBe('42')
    expect(tokens[0]!.sym).toBe('GOLD')
  })

  it('reads one token by filing tag instead of scanning the basket', async () => {
    const lockingScript = buildBsv21ValueLock({
      layout: 'brc162',
      tokenId: TOKEN_A,
      amount: 42n,
      address: ADDR,
    })
    const calls: Array<{ basket?: string; tags?: string[] }> = []
    const wallet = {
      identityKey: '',
      wallet: {
        listOutputs: async (args: { basket?: string; tags?: string[] }) => {
          calls.push(args)
          return {
            outputs:
              args.tags?.[0] === `p2pft:${TOKEN_A}`
                ? [{
                    outpoint: `${'aa'.repeat(32)}.1`,
                    satoshis: 1,
                    tags: ['p2pft', `p2pft:${TOKEN_A}`],
                    lockingScript,
                  }]
                : [],
          }
        },
      },
    } as never
    const { listBsv21BinaryTipsForToken } = await import('./token/listTips')

    const tips = await listBsv21BinaryTipsForToken(wallet, TOKEN_A)

    expect(tips).toHaveLength(1)
    expect(calls.map((call) => call.tags?.[0])).toEqual([
      `p2pft:${TOKEN_A}`,
      `bsv21:${TOKEN_A}`,
    ])
    expect(calls.every((call) => call.basket === 'p2pft')).toBe(true)
  })

  it('does not turn a failed send-path filing read into an empty balance', async () => {
    const wallet = {
      wallet: {
        listOutputs: async () => {
          throw new Error('storage unavailable')
        },
      },
    } as never
    const { listBsv21BinaryTipsForToken } = await import('./token/listTips')

    await expect(listBsv21BinaryTipsForToken(wallet, TOKEN_A)).rejects.toThrow(
      'storage unavailable',
    )
  })
})


describe('decodeListedBsv21Tip remittance-only', () => {
  it('refuses remittance-only 1-sat with no 162 binary', async () => {
    const { decodeListedBsv21Tip } = await import('./token/listTips')
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
    const { encodeBsv21Binary } = await import('./token')
    const { decodeListedBsv21Tip } = await import('./token/listTips')
    const deployOut = `${'aa'.repeat(32)}_0`
    const script = encodeBsv21Binary({
      layout: 'draft-tagged',
      amount: 50n,
      payload: { sym: 'GOLD', icon: Uint8Array.from([2, 0, 0, 0]) },
      rest: `76a914${'11'.repeat(20)}88ac`,
    }).toHex()
    const tip = decodeListedBsv21Tip({
      outpoint: deployOut.replace('_', '.'),
      satoshis: 1,
      lockingScript: script,
    })
    expect(tip?.binarySupply).toBe('locked')
    expect(tip?.icon).toBe(`${'aa'.repeat(32)}_2`)
    expect(tip?.sym).toBe('GOLD')
  })
})
