import { BigNumber, KeyDeriver, PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import type { ActiveWallet } from './session'
import {
  signedRequestHeaders,
  signedRequestPreimage,
  walletAuthorityKey,
} from './signedRequest'

describe('wallet-authority signed requests', () => {
  it('derives the same authority that existing holder records are keyed by', () => {
    const keyHex = PrivateKey.fromRandom().toHex()
    const active = {
      vaultMaster: { derivation: 'brc-42', keyHex },
    } as ActiveWallet
    const expected = new KeyDeriver(PrivateKey.fromHex(keyHex))
      .derivePrivateKey([2, 'brc250 device'], '1', 'self')
    expect(walletAuthorityKey(active).toHex()).toBe(expected.toHex())
  })

  it('signs the canonical request that the holder verifies', () => {
    const key = PrivateKey.fromRandom()
    const body = '{"binding":"abc"}'
    const headers = signedRequestHeaders(key, 'POST', '/v1/login/start', body)
    const raw = Utils.toArray(headers['X-BRC250-Signature']!, 'hex')
    const sig = new Signature(
      new BigNumber(raw.slice(0, 32)),
      new BigNumber(raw.slice(32)),
    )
    const preimage = signedRequestPreimage(
      'POST',
      '/v1/login/start',
      Number(headers['X-BRC250-Timestamp']),
      headers['X-BRC250-Nonce']!,
      body,
    )
    expect(
      PublicKey.fromString(headers['X-BRC250-Key']!).verify(
        Utils.toArray(preimage, 'utf8'),
        sig,
      ),
    ).toBe(true)
  })
})
