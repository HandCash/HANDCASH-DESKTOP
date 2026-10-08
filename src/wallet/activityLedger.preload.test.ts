import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

vi.mock('./walletRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./walletRuntime')>()),
  getWalletRuntime: () => ({ storageNamespace: 'ns', instance: {} }),
  runtimeIsCurrent: () => true,
}))

import { exportAllActivity, listActivityFeed } from './appActivity'
import {
  paintSavedActivityLedger,
  preloadActivityLedger,
  resetActivityLedgerForTests,
} from './activityLedger'
import * as ledgerStore from './activityLedgerStore'
import type { WalletRuntime } from './walletRuntime'

const tx = 'ab'.repeat(32)
const runtime = { storageNamespace: 'ns', instance: {} } as unknown as WalletRuntime
const row = {
  id: `ledger:${tx}:${tx}.0`,
  origin: 'handcash',
  kind: 'spent' as const,
  method: 'send-collectable',
  sats: 1,
  at: 10,
  txid: tx,
  note: 'Sent collectable',
  item: { name: 'Fox', origin: `${tx}_0`, outpoint: `${tx}.0` },
}

describe('Activity projection at launch', () => {
  beforeEach(() => {
    store.clear()
    resetActivityLedgerForTests()
    vi.restoreAllMocks()
  })

  it('paints the preloaded history in the same turn, without a second copy or a write-back', async () => {
    await ledgerStore.saveLedgerRows('ns', [row])
    await preloadActivityLedger('ns')
    const load = vi.spyOn(ledgerStore, 'loadLedgerRows')
    const save = vi.spyOn(ledgerStore, 'saveLedgerRows')
    vi.useFakeTimers()
    try {
      paintSavedActivityLedger(runtime)
      expect(listActivityFeed(10).map((entry) => entry.id)).toEqual([row.id])
      expect(exportAllActivity()).toEqual([])
      await vi.advanceTimersByTimeAsync(10_000)
    } finally {
      vi.useRealTimers()
    }
    expect(load).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('does not read storage again after an empty preload', async () => {
    await preloadActivityLedger('fresh')
    const load = vi.spyOn(ledgerStore, 'loadLedgerRows')
    paintSavedActivityLedger({ ...runtime, storageNamespace: 'fresh' } as WalletRuntime)
    await Promise.resolve()
    expect(load).not.toHaveBeenCalled()
    expect(listActivityFeed(10)).toEqual([])
  })

  it('reads the saved history when unlock did not preload it', async () => {
    await ledgerStore.saveLedgerRows('ns', [row])
    paintSavedActivityLedger(runtime)
    await vi.waitFor(() => expect(listActivityFeed(10).map((entry) => entry.id)).toEqual([row.id]))
  })
})
