import { BigNumber, PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import type { ActiveWallet } from '../session'
import {
  authorityPrivateKey,
  comparisonCode,
  commitmentFor,
  requestPreimage,
  signedHeaders,
} from './crypto'

describe('BRC-250 wallet cryptography', () => {
  it('derives one stable authority from vault account zero', () => {
    const active = {
      vaultMaster: {
        derivation: 'brc-42',
        keyHex: PrivateKey.fromRandom().toHex(),
      },
    } as ActiveWallet
    expect(authorityPrivateKey(active).toHex()).toBe(
      authorityPrivateKey(active).toHex(),
    )
  })

  it('signs the canonical request that the host verifies', () => {
    const key = PrivateKey.fromRandom()
    const body = '{"binding":"abc"}'
    const headers = signedHeaders(key, 'POST', '/v1/login/start', body)
    const raw = Utils.toArray(headers['X-BRC250-Signature']!, 'hex')
    const sig = new Signature(
      new BigNumber(raw.slice(0, 32)),
      new BigNumber(raw.slice(32)),
    )
    const preimage = requestPreimage(
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

  it('binds commitments and comparison codes to this login', () => {
    const key = PrivateKey.fromRandom().toPublicKey()
    expect(commitmentFor(key, 'aa'.repeat(32))).not.toBe(
      commitmentFor(key, 'bb'.repeat(32)),
    )
    expect(
      comparisonCode('binding', 'aa'.repeat(32), 'bb'.repeat(32)),
    ).toMatch(/^\d{8}$/)
  })
})
