import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
  durableRemoveItem: (key: string) => {
    store.delete(key)
    return true
  },
}))

vi.mock('./walletRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./walletRuntime')>()),
  getWalletRuntime: () => ({ storageNamespace: 'ns', instance: {} }),
  runtimeIsCurrent: () => true,
}))

import { publishActivityLedger, resetActivityLedgerForTests } from './activityLedger'
import { noteJobTxids, itemMigrateTxDescription, resetActivityJobIndexForTests } from './activityJobIndex'
import { listActivityFeed, mergeActivityEntries, upsertAppActivity, type ActivityEntry } from './appActivity'
import { __resetGhostTxSuppressForTests, rememberGhostTx } from './ghostTxSuppress'

const tx = (n: number) => n.toString(16).padStart(64, '0')

function row(partial: Partial<ActivityEntry> & { id: string }): ActivityEntry {
  return { origin: 'handcash', kind: 'spent', sats: 1, at: 1, method: 'send', ...partial }
}

const ledgerCoin = (n: number, at = n) =>
  row({ id: `ledger:${tx(n)}`, txid: tx(n), at, sats: 100, note: 'Sent' })

const ledger = (count: number) => Array.from({ length: count }, (_, i) => ledgerCoin(i + 1))

const ids = (rows: readonly ActivityEntry[]) => rows.map((r) => r.id)

describe('Activity feed updates incrementally', () => {
  beforeEach(() => {
    store.clear()
    resetActivityLedgerForTests()
    resetActivityJobIndexForTests()
    __resetGhostTxSuppressForTests()
  })

  it('keeps every ledger row the same object across a write that covers none of them', () => {
    publishActivityLedger('ns', ledger(500))
    const before = listActivityFeed(1_000)

    upsertAppActivity({ origin: 'shop.example', kind: 'spent', sats: 5, method: 'createAction', note: 'tip' })
    const after = listActivityFeed(1_000)

    expect(after).toHaveLength(before.length + 1)
    const byId = new Map(before.map((r) => [r.id, r]))
    for (const r of after.filter((r) => r.id.startsWith('ledger:'))) expect(r).toBe(byId.get(r.id))
  })

  it('hides a ledger row once a stored row tells its transaction, and only that one', () => {
    publishActivityLedger('ns', ledger(300))
    listActivityFeed(1_000)

    mergeActivityEntries([row({ id: 'paid', txid: tx(42), origin: 'shop.example', sats: 100, at: 42 })])
    const feed = ids(listActivityFeed(1_000))

    expect(feed).toContain('paid')
    expect(feed).not.toContain(`ledger:${tx(42)}`)
    expect(feed).toContain(`ledger:${tx(41)}`)
    expect(feed).toHaveLength(300)
  })

  it('hides a ghost transaction on the next rebuild', () => {
    publishActivityLedger('ns', ledger(50))
    listActivityFeed(100)

    rememberGhostTx(tx(7))
    upsertAppActivity({ origin: 'shop.example', kind: 'spent', sats: 5, method: 'createAction', note: 'bump' })

    expect(ids(listActivityFeed(100))).not.toContain(`ledger:${tx(7)}`)
  })

  it('orders newest first, the stored row first on a tie, as one stable sort did', () => {
    publishActivityLedger('ns', [ledgerCoin(1, 10), ledgerCoin(2, 20), ledgerCoin(3, 30)])
    mergeActivityEntries([
      row({ id: 'tie', origin: 'shop.example', at: 20, method: 'createAction' }),
      row({ id: 'newest', origin: 'shop.example', at: 40, method: 'createAction' }),
      row({ id: 'archived', origin: 'shop.example', at: 35, method: 'createAction', archivedAt: 1 }),
    ])

    expect(ids(listActivityFeed(10))).toEqual(['newest', `ledger:${tx(3)}`, 'tie', `ledger:${tx(2)}`, `ledger:${tx(1)}`])
  })

  it('keeps folded import legs the same objects when the hidden set changes', () => {
    const legs = [1, 2, 3].map((n) =>
      row({
        id: `ledger:${tx(n)}:${tx(n)}.0`,
        txid: tx(n),
        at: n,
        kind: 'earned',
        method: 'receive-collectable',
        note: itemMigrateTxDescription(1, `${tx(n)}.0`),
        item: { name: 'Fox', origin: `${tx(n)}_0`, outpoint: `${tx(n)}.0` },
      }),
    )
    noteJobTxids('job:item-import:run', [tx(1), tx(2), tx(3)])
    publishActivityLedger('ns', [...legs, ledgerCoin(9, 9)])
    const before = listActivityFeed(10).filter((r) => r.item)

    mergeActivityEntries([row({ id: 'paid', txid: tx(9), origin: 'shop.example', sats: 100, at: 9 })])
    const after = listActivityFeed(10).filter((r) => r.item)

    expect(after.length).toBe(before.length)
    expect(after.length).toBeGreaterThan(0)
    after.forEach((r, i) => expect(r).toBe(before[i]))
  })
})
