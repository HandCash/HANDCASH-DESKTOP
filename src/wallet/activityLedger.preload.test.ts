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
  consumeActivityLedgerPrime,
  preloadActivityLedger,
  publishActivityLedger,
  resetActivityLedgerForTests,
} from './activityLedger'
import { saveLedgerRows } from './activityLedgerStore'

const tx = 'ab'.repeat(32)

describe('Activity projection at launch', () => {
  beforeEach(() => {
    store.clear()
    resetActivityLedgerForTests()
  })

  it('paints the saved transaction history without a second copy in the activity store', async () => {
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
    await saveLedgerRows('ns', [row])
    await preloadActivityLedger('ns')
    const primed = consumeActivityLedgerPrime('ns')
    expect(primed?.map((entry) => entry.id)).toEqual([row.id])
    expect(consumeActivityLedgerPrime('ns')).toBeNull()

    publishActivityLedger('ns', primed!)
    expect(exportAllActivity()).toEqual([])
    expect(listActivityFeed(10).map((entry) => entry.id)).toEqual([row.id])
  })
})
