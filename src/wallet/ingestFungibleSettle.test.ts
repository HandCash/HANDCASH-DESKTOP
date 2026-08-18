import { describe, expect, it } from 'vitest'
import { internalizePeerFungibleSettle } from './ingestFungibleSettle'

const TOKEN_ID = `${'ab'.repeat(32)}_0`

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
})
