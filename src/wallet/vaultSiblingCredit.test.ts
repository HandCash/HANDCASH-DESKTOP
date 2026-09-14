import { beforeEach, describe, expect, it, vi } from 'vitest'

const durable = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => durable.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    durable.set(key, value)
    return true
  },
}))

vi.mock('@bsv/wallet-toolbox-client', () => ({
  SetupClient: {
    createWalletIdb: vi.fn(),
  },
}))

vi.mock('./legacyBeef', () => ({
  withVisibleOnChainBeef: async <T>(run: () => Promise<T>) => run(),
}))

vi.mock('./peerIngestHelpers', () => ({
  alreadyInternalizedError: (err: unknown) =>
    /already internalized/i.test(err instanceof Error ? err.message : String(err)),
  withRestoredInternalizeStatus: async <T>(_txid: string, run: () => Promise<T>) =>
    run(),
}))

vi.mock('./appActivity', () => ({
  noteInboundReceiveComplete: vi.fn(),
  rebindAppActivityForAccount: vi.fn(),
}))

vi.mock('./accountLocalKeys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./accountLocalKeys')>()
  return actual
})

describe('creditVaultSiblingBrc29Payment', () => {
  beforeEach(() => {
    durable.clear()
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('refuses same-account and missing remittance without opening a toolbox', async () => {
    const { SetupClient } = await import('@bsv/wallet-toolbox-client')
    const { creditVaultSiblingBrc29Payment, resetVaultSiblingCreditForTests } =
      await import('./vaultSiblingCredit')
    resetVaultSiblingCreditForTests()

    const active = {
      accountIndex: 1,
      identityKey: 'ik-active',
      masterRootKeyHex: 'aa'.repeat(32),
      handle: 'user',
      chain: 'main' as const,
    }

    const same = await creditVaultSiblingBrc29Payment({
      active: active as never,
      account: { index: 1, name: 'Self', identityKey: 'ik-active' },
      txid: 'ab'.repeat(32),
      remittance: { derivationPrefix: 'p', derivationSuffix: 's', outputIndex: 0 },
      senderIdentityKey: 'ik-active',
      atomicBeef: [1, 2, 3],
      satoshis: 1000,
    })
    expect(same.reason).toBe('same-account')
    expect(SetupClient.createWalletIdb).not.toHaveBeenCalled()

    const missing = await creditVaultSiblingBrc29Payment({
      active: { ...active, accountIndex: 0 } as never,
      account: { index: 1, name: 'Child', identityKey: 'ik-child' },
      txid: 'ab'.repeat(32),
      remittance: { derivationPrefix: '', derivationSuffix: '', outputIndex: 0 },
      senderIdentityKey: 'ik-root',
      atomicBeef: [1, 2, 3],
      satoshis: 1000,
    })
    expect(missing.reason).toBe('missing-remittance')
    expect(SetupClient.createWalletIdb).not.toHaveBeenCalled()
  })

  it('treats already-internalized as success and writes sibling toolbox balance only', async () => {
    const { SetupClient } = await import('@bsv/wallet-toolbox-client')
    const stopTasks = vi.fn()
    const destroy = vi.fn(async () => {})
    const abort = vi.fn(async () => true)
    const balance = vi.fn(async () => 55_000)
    const internalizeAction = vi.fn(async () => {
      throw new Error('transaction already internalized')
    })
    ;(SetupClient.createWalletIdb as ReturnType<typeof vi.fn>).mockResolvedValue({
      monitor: { stopTasks },
      wallet: { internalizeAction, balance, destroy, actionBatch: { abort } },
      storage: { destroy },
      activeStorage: { destroy },
    })

    const {
      creditVaultSiblingBrc29Payment,
      resetVaultSiblingCreditForTests,
    } = await import('./vaultSiblingCredit')
    resetVaultSiblingCreditForTests()

    const active = {
      accountIndex: 0,
      identityKey: 'ik-root',
      masterRootKeyHex: '11'.repeat(32),
      handle: 'user',
      chain: 'main' as const,
    }
    const txid = 'cd'.repeat(32)
    const first = await creditVaultSiblingBrc29Payment({
      active: active as never,
      account: { index: 1, name: 'Child', identityKey: 'ik-child' },
      txid,
      remittance: {
        derivationPrefix: 'prefix',
        derivationSuffix: 'suffix',
        outputIndex: 0,
      },
      senderIdentityKey: 'ik-root',
      atomicBeef: [9, 8, 7],
      satoshis: 12_000,
    })
    expect(first.accepted).toBe(true)
    expect(first.balanceSats).toBe(55_000)
    expect(stopTasks).toHaveBeenCalled()
    expect(destroy).toHaveBeenCalled()
    expect(abort).toHaveBeenCalled()

    const { readTrustedBalance } = await import('./balanceSnapshot')
    expect(readTrustedBalance('ik-child', 'main')).toBe(55_000)

    // Second call is txid-keyed idempotent — no second SetupClient.
    ;(SetupClient.createWalletIdb as ReturnType<typeof vi.fn>).mockClear()
    const second = await creditVaultSiblingBrc29Payment({
      active: active as never,
      account: { index: 1, name: 'Child', identityKey: 'ik-child' },
      txid,
      remittance: {
        derivationPrefix: 'prefix',
        derivationSuffix: 'suffix',
        outputIndex: 0,
      },
      senderIdentityKey: 'ik-root',
      atomicBeef: [9, 8, 7],
      satoshis: 12_000,
    })
    expect(second.accepted).toBe(true)
    expect(second.reason).toBe('already-credited')
    expect(SetupClient.createWalletIdb).not.toHaveBeenCalled()
  })
})
