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
  wasItemReceivedAnnounced: () => false,
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

function ingestedItems(count: number, start = 1) {
  return Array.from({ length: count }, (_, i) => ({
    outpoint: `${(start + i).toString(16).padStart(64, '0')}.0`,
    chain: 'main' as const,
    name: `Item ${start + i}`,
  }))
}

async function resumePendingYields(): Promise<void> {
  for (const resume of pendingYields.splice(0)) resume()
  await Promise.resolve()
}

describe('collectables account-switch announcements', () => {
  beforeEach(() => {
    durable.clear()
    pendingYields.length = 0
    announceItemsReceived.mockReset()
    vi.resetModules()
  })

  it('coalesces a burst of large lists into the latest display notification', async () => {
    const collectables = await import('./collectables')
    const listener = vi.fn()
    const unsubscribe = collectables.subscribeCollectables(listener)
    try {
      collectables.noteIngestedItems(ingestedItems(121))
      for (let i = 0; i < 20; i++) {
        collectables.noteIngestedItems(ingestedItems(1, 122 + i))
      }
      // Account-local state is current before the deferred display paints.
      expect(collectables.getCachedCollectables()).toHaveLength(141)
      expect(listener).toHaveBeenCalledTimes(1)
      await resumePendingYields()
      expect(listener).toHaveBeenCalledTimes(2)
      expect(listener.mock.calls[1]![0]).toHaveLength(141)
    } finally {
      unsubscribe()
    }
  })

  it.each([true, false])('does not replay a queued large list after clear (notify=%s)', async (notify) => {
    const collectables = await import('./collectables')
    const listener = vi.fn()
    const unsubscribe = collectables.subscribeCollectables(listener)
    try {
      collectables.noteIngestedItems(ingestedItems(121))
      collectables.clearCollectablesCache({ notify })
      listener.mockClear()
      await resumePendingYields()
      expect(listener).not.toHaveBeenCalled()
      expect(collectables.getCachedCollectables()).toEqual([])
    } finally {
      unsubscribe()
    }
  })

  it('does not notify the new account with a queued prior account list', async () => {
    const collectables = await import('./collectables')
    const listener = vi.fn()
    const unsubscribe = collectables.subscribeCollectables(listener)
    try {
      collectables.noteIngestedItems(ingestedItems(121))
      collectables.rebindCollectablesForAccount()
      listener.mockClear()
      await resumePendingYields()
      expect(listener.mock.calls.every(([items]) => items.length === 0)).toBe(true)
    } finally {
      unsubscribe()
    }
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
