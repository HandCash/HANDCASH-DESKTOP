import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@bsv/wallet-toolbox-client', () => ({
  SetupClient: { createWalletIdb: vi.fn() },
}))

vi.mock('./balanceSnapshot', () => ({
  writeTrustedBalance: vi.fn(),
}))

vi.mock('./legacyBeef', () => ({
  withVisibleOnChainBeef: async (fn: () => Promise<unknown>) => fn(),
}))

vi.mock('./vaultAccounts', () => ({
  rootKeyHexForAccount: () => '00'.repeat(32),
  toolboxDatabaseName: () => 'test-db',
}))

describe('creditVaultSiblingBrc29Payment', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('is permanently disabled after the v1.3.146 double-balance break', async () => {
    const { creditVaultSiblingBrc29Payment, resetVaultSiblingCreditForTests } =
      await import('./vaultSiblingCredit')
    resetVaultSiblingCreditForTests()
    const result = await creditVaultSiblingBrc29Payment({
      active: {
        accountIndex: 0,
        masterRootKeyHex: '11'.repeat(32),
        identityKey: 'sender',
        handle: 'h',
        chain: 'main',
      } as never,
      account: {
        index: 1,
        identityKey: 'child',
        label: 'Child',
      } as never,
      txid: 'aa'.repeat(32),
      remittance: {
        derivationPrefix: 'p',
        derivationSuffix: 's',
        outputIndex: 0,
      } as never,
      senderIdentityKey: 'sender',
      atomicBeef: [1, 2, 3],
      satoshis: 1000,
    })
    expect(result).toEqual({
      accepted: false,
      balanceSats: null,
      accountIndex: 1,
      identityKey: 'child',
      reason: 'disabled',
    })
  })
})
