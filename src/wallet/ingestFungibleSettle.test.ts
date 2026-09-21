import { beforeEach, describe, expect, it, vi } from 'vitest'
import { internalizePeerFungibleSettle } from './token/settle'

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
