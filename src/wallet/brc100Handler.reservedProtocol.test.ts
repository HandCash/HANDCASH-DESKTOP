import type { WalletInterface } from '@bsv/sdk'
import { describe, expect, it, vi } from 'vitest'
import { dispatchWalletMethod } from './brc100Handler'

function fakeWallet() {
  const call = vi.fn(async () => ({ ok: true }))
  const wallet = new Proxy({} as Record<string, unknown>, {
    get: () => call,
  }) as unknown as WalletInterface
  return { wallet, call }
}

const KEY_METHODS = [
  'getPublicKey',
  'createSignature',
  'verifySignature',
  'encrypt',
  'decrypt',
  'createHmac',
  'verifyHmac',
  'revealSpecificKeyLinkage',
] as const

describe('BRC-100 dispatch refuses the vault account protocol (BRC-208)', () => {
  it.each(KEY_METHODS)('%s never reaches the wallet for [2, "account"]', async (method) => {
    const { wallet, call } = fakeWallet()
    await expect(
      dispatchWalletMethod(
        wallet,
        method,
        { protocolID: [2, 'account'], keyID: 'account-1', counterparty: 'self' },
        'example.com',
      ),
    ).rejects.toThrow(/reserved/)
    expect(call).not.toHaveBeenCalled()
  })

  it('matches the name the way BRC-43 normalises it', async () => {
    const { wallet, call } = fakeWallet()
    await expect(
      dispatchWalletMethod(
        wallet,
        'createSignature',
        { protocolID: [2, ' Account '], keyID: 'account-1', counterparty: 'self', hashToDirectlySign: [1] },
        'example.com',
      ),
    ).rejects.toThrow(/reserved/)
    expect(call).not.toHaveBeenCalled()
  })

  it('reserves the name at every security level', async () => {
    const { wallet, call } = fakeWallet()
    await expect(
      dispatchWalletMethod(
        wallet,
        'getPublicKey',
        { protocolID: [1, 'account'], keyID: 'account-1', counterparty: 'self' },
        'example.com',
      ),
    ).rejects.toThrow(/reserved/)
    expect(call).not.toHaveBeenCalled()
  })

  it('never reveals counterparty linkage with the wallet itself', async () => {
    const { wallet, call } = fakeWallet()
    await expect(
      dispatchWalletMethod(
        wallet,
        'revealCounterpartyKeyLinkage',
        { counterparty: 'self', verifier: '02'.padEnd(66, '1') },
        'example.com',
      ),
    ).rejects.toThrow(/linkage with itself/)
    expect(call).not.toHaveBeenCalled()
  })

  it('never reveals the offset of an exported developer key', async () => {
    const { wallet, call } = fakeWallet()
    await expect(
      dispatchWalletMethod(
        wallet,
        'revealSpecificKeyLinkage',
        {
          protocolID: [2, 'handcash server wallet'],
          keyID: '1',
          counterparty: 'self',
          verifier: '02'.padEnd(66, '1'),
        },
        'example.com',
      ),
    ).rejects.toThrow(/linkage with itself/)
    expect(call).not.toHaveBeenCalled()
  })

  it('still serves other protocols', async () => {
    const { wallet, call } = fakeWallet()
    await dispatchWalletMethod(
      wallet,
      'getPublicKey',
      { protocolID: [2, 'accounting'], keyID: '1', counterparty: 'self' },
      'example.com',
    )
    expect(call).toHaveBeenCalledTimes(1)
  })
})
