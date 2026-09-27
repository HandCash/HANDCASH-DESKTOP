import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeBsv21Binary } from './token/decode162'
import { p2pkhScriptHex } from './ordinalOwnership'
import {
  collectFungibleTipsPayingUs,
  internalizePeerFungibleSettle,
} from './token/settle'

const atomicBeefForSubject = vi.fn()

vi.mock('./beefCache', () => ({
  atomicBeefForSubject: (...args: unknown[]) => atomicBeefForSubject(...args),
  rememberBeefTree: vi.fn(),
}))

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    address: '1receiver',
    wallet: { internalizeAction: vi.fn() },
  }),
}))

const TOKEN_ID = `${'ab'.repeat(32)}_0`

beforeEach(() => {
  atomicBeefForSubject.mockReset()
})

describe('internalizePeerFungibleSettle', () => {
  it('refuses an invalid txid before touching the wallet', async () => {
    expect(
      await internalizePeerFungibleSettle({
        txid: 'nope',
        token: {
          kind: 'fungible',
          tokenId: TOKEN_ID,
          amount: '10',
          sym: 'TST',
          dec: 0,
        },
      }),
    ).toEqual({
      accepted: false,
      outpoints: [],
      reason: 'invalid-txid',
    })
  })

  it('refuses malformed token remittance before touching the wallet', async () => {
    expect(
      await internalizePeerFungibleSettle({
        txid: 'cd'.repeat(32),
        token: {
          kind: 'fungible',
          tokenId: 'bad',
          amount: '0',
          sym: 'TST',
          dec: 0,
        },
      }),
    ).toEqual({
      accepted: false,
      outpoints: [],
      reason: 'invalid-token-remittance',
    })
  })

  it('re-frames peer BEEF for the fungible subject before ingest', async () => {
    const txid = 'cd'.repeat(32)
    const plainBeef = [1, 2, 3]
    atomicBeefForSubject.mockReturnValue(undefined)

    await expect(
      internalizePeerFungibleSettle({
        txid,
        tx: plainBeef,
        beefPurpose: 'inboundItemHint',
        token: {
          kind: 'fungible',
          tokenId: TOKEN_ID,
          amount: '10',
          sym: 'TST',
          dec: 0,
        },
      }),
    ).resolves.toEqual({
      accepted: false,
      outpoints: [],
      reason: 'missing-beef',
    })

    expect(atomicBeefForSubject).toHaveBeenCalledWith(plainBeef, txid)
  })
})

const SELF = '19aXSPsoR45Uuxk4LUonJ672zGFf57wfrD'
const OTHER = '1BitcoinEaterAddressDontSendf59kuE'
const SELF_TOKEN = `${'cd'.repeat(32)}_0`

function tokenOutput(amount: bigint, address: string) {
  return {
    satoshis: 1 as const,
    lockingScript: encodeBsv21Binary({
      tokenId: SELF_TOKEN,
      amount,
      rest: p2pkhScriptHex(address),
    }),
  }
}

describe('collectFungibleTipsPayingUs', () => {
  it('accepts both outputs of a self-send when the payment and the change are the same amount', () => {
    const { tips } = collectFungibleTipsPayingUs({
      outputs: [
        tokenOutput(500n, SELF),
        { satoshis: 12_000, lockingScript: encodeBsv21Binary({ amount: 1n, rest: p2pkhScriptHex(SELF) }) },
        tokenOutput(500n, SELF),
      ],
      address: SELF,
      tokenId: SELF_TOKEN,
      amount: '500',
    })
    expect(tips.map((tip) => tip.vout)).toEqual([0, 2])
    expect(tips.every((tip) => tip.encoding === 'binary')).toBe(true)
  })

  it('leaves a different-amount change for the sender and keeps only the payment', () => {
    const { tips } = collectFungibleTipsPayingUs({
      outputs: [tokenOutput(300n, OTHER), tokenOutput(700n, SELF)],
      address: OTHER,
      tokenId: SELF_TOKEN,
      amount: '300',
    })
    expect(tips.map((tip) => tip.vout)).toEqual([0])
  })
})
