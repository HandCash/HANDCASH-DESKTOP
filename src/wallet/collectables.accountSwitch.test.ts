import { beforeEach, describe, expect, it, vi } from 'vitest'

const pendingYields = vi.hoisted(() => [] as Array<() => void>)
vi.mock('./yieldToUi', () => ({
  yieldToUi: () =>
    new Promise<void>((resolve) => {
      pendingYields.push(resolve)
    }),
}))

const announceItemsReceived = vi.hoisted(() => vi.fn())
vi.mock('./itemArrivalToast', () => ({
  announceItemsReceived,
  announceItemVerified: vi.fn(),
  rebindItemArrivalToastForAccount: vi.fn(),
}))

vi.mock('./sentItemGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sentItemGuard')>()),
  isItemSent: () => false,
  getSentItemRecord: () => null,
}))

vi.mock('./legacyScan', () => ({
  scanLegacyAddress: vi.fn(async () => ({
    address: '1Primary',
    chain: 'main' as const,
    sats: 0,
    utxos: [],
    source: 'bitails' as const,
  })),
}))

const durable = vi.hoisted(() => new Map<string, string>())
vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => durable.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    durable.set(key, value)
    return true
  },
  durableRemoveItem: (key: string) => durable.delete(key),
}))

const active = vi.hoisted(() => ({
  wallet: {
    address: '1Primary',
    identityKey: `02${'1'.repeat(64)}`,
    chain: 'main' as const,
    wallet: {
      listOutputs: vi.fn(async () => ({ outputs: [] })),
    },
  },
}))
vi.mock('./session', () => ({
  getActiveWallet: () => active.wallet,
}))

describe('collectables account-switch announcements', () => {
  beforeEach(() => {
    durable.clear()
    pendingYields.length = 0
    announceItemsReceived.mockReset()
    vi.resetModules()
  })

  it('drops a prior wallet receive announcement after account rebind', async () => {
    const collectables = await import('./collectables')
    collectables.noteIngestedItem({
      outpoint: `${'a'.repeat(64)}.0`,
      chain: 'main',
      name: 'Primary item',
    })

    collectables.rebindCollectablesForAccount()
    while (pendingYields.length > 0) pendingYields.shift()?.()
    await Promise.resolve()

    expect(announceItemsReceived).not.toHaveBeenCalled()
  })
})
