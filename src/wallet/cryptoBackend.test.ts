import { describe, expect, it } from 'vitest'
import { BigNumber, ECDSA, Hash, PrivateKey, Signature } from '@bsv/sdk'
import { walletCryptoBackend } from './cryptoBackend'

const registered = () =>
  (globalThis as { __bsvSdkAsyncCryptoBackendV1?: unknown }).__bsvSdkAsyncCryptoBackendV1

describe('walletCryptoBackend', () => {
  it('registers one verifier per chain as the SDK backend', () => {
    const main = walletCryptoBackend('main')
    expect(main).toBeDefined()
    expect(walletCryptoBackend('main')).toBe(main)
    expect(registered()).toBe(main)

    const test = walletCryptoBackend('test')
    expect(test).not.toBe(main)
    expect(registered()).toBe(test)

    walletCryptoBackend('main')
    expect(registered()).toBe(main)
  })

  it('produces signatures the JavaScript SDK verifies', async () => {
    const backend = walletCryptoBackend('main')!
    await backend.preload()
    const key = PrivateKey.fromRandom()
    const digest = Uint8Array.from(Hash.sha256('handcash'))
    const der = await backend.signDigest(Uint8Array.from(key.toArray('be', 32)), digest)
    const signature = Signature.fromDER(Array.from(der))
    expect(ECDSA.verify(new BigNumber(Array.from(digest)), signature, key.toPublicKey())).toBe(true)
    expect(
      await backend.verifyDigest(
        Uint8Array.from(key.toPublicKey().encode(true) as number[]),
        digest,
        der,
      ),
    ).toBe(true)
  })
})
