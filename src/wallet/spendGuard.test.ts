import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WalletCoordinatorSnapshot } from './walletCoordinatorMachine'

const refreshFromChain = vi.fn(async (_opts?: unknown): Promise<number | null> => 100)
const refreshFromChainDuringSpend = vi.fn(
  async (_opts?: unknown): Promise<number | null> => 200,
)

const idleSnapshot: WalletCoordinatorSnapshot = {
  chainIngest: 'idle',
  spend: 'idle',
  historyReplica: 'idle',
  recompose: 'idle',
}

const getWalletCoordinatorSnapshot = vi.fn(
  (): WalletCoordinatorSnapshot => idleSnapshot,
)

vi.mock('./chainIngest', () => ({
  refreshFromChain: (opts?: unknown) => refreshFromChain(opts),
  refreshFromChainDuringSpend: (opts?: unknown) => refreshFromChainDuringSpend(opts),
}))

vi.mock('./walletCoordinator', () => ({
  getWalletCoordinatorSnapshot: () => getWalletCoordinatorSnapshot(),
  runExclusiveSpend: async <T>(
    fn: () => Promise<T>,
    acquireLease: () => Promise<() => Promise<void>>,
  ) => {
    const release = await acquireLease()
    try {
      return await fn()
    } finally {
      await release()
    }
  },
}))

vi.mock('./spendLease', () => ({
  acquireSpendLease: async () => async () => undefined,
}))

vi.mock('./paymentPolicy', () => ({
  assertOnlineForPayment: () => undefined,
}))

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    wallet: {},
    services: {},
    rootKeyHex: '00',
    identityKey: '02',
    address: '1abc',
    handle: 'test',
    chain: 'main',
  }),
  fetchBalanceSats: async () => 50,
}))

describe('refreshSpendableBalance', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    getWalletCoordinatorSnapshot.mockReturnValue(idleSnapshot)
    const { invalidateFundingHealCache } = await import('./spendGuard')
    invalidateFundingHealCache()
  })

  it('uses top-level chain ingest outside a spend session', async () => {
    const { refreshSpendableBalance } = await import('./spendGuard')
    await expect(refreshSpendableBalance()).resolves.toBe(100)
    expect(refreshFromChain).toHaveBeenCalledTimes(1)
    expect(refreshFromChainDuringSpend).not.toHaveBeenCalled()
  })

  it('nests chain ingest while a spend session is active', async () => {
    getWalletCoordinatorSnapshot.mockReturnValue({
      ...idleSnapshot,
      spend: 'active',
    })
    const { refreshSpendableBalance } = await import('./spendGuard')
    await expect(refreshSpendableBalance()).resolves.toBe(200)
    expect(refreshFromChainDuringSpend).toHaveBeenCalledTimes(1)
    expect(refreshFromChain).not.toHaveBeenCalled()
  })
})
