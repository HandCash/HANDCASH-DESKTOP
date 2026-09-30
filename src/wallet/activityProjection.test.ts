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

import { publishActivityLedger, resetActivityLedgerForTests } from './activityLedger'
import {
  exportAllActivity,
  getActivityById,
  listActivityFeed,
  listRecentActivity,
  mergeActivityEntries,
  noteInboundReceiveComplete,
  noteInboundReceivePending,
  removeActivityById,
  upsertAppActivity,
  sameActivityRow,
  type ActivityEntry,
} from './appActivity'

const tx = (n: number) => n.toString(16).padStart(64, '0')

function row(partial: Partial<ActivityEntry> & { id: string }): ActivityEntry {
  return { origin: 'handcash', kind: 'spent', sats: 1, at: 1, method: 'send', ...partial }
}

const ledgerCoin = (n: number, partial: Partial<ActivityEntry> = {}) =>
  row({ id: `ledger:${tx(n)}`, txid: tx(n), at: n, sats: 100, note: 'Sent', ...partial })

const ledgerItem = (n: number, outpoint: string, kind: 'spent' | 'earned') =>
  row({
    id: `ledger:${tx(n)}:${outpoint}`,
    txid: tx(n),
    at: n,
    kind,
    method: kind === 'spent' ? 'send-collectable' : 'receive-collectable',
    item: { name: 'Collectable', origin: outpoint.replace('.', '_'), outpoint },
  })

describe('Activity over the wallet ledger', () => {
  beforeEach(() => {
    vi.useRealTimers()
    store.clear()
    resetActivityLedgerForTests()
  })

  it('shows settled history the store no longer holds, to display only', () => {
    publishActivityLedger('ns', [ledgerCoin(1), ledgerCoin(2)])

    expect(listActivityFeed(10).map((e) => e.id)).toEqual([`ledger:${tx(2)}`, `ledger:${tx(1)}`])
    expect(getActivityById(`ledger:${tx(1)}`)).toMatchObject({ txid: tx(1), sats: 100 })
    expect(listRecentActivity(10)).toEqual([])
    expect(exportAllActivity()).toEqual([])
  })

  it('lets the stored row tell its transaction instead of doubling it', () => {
    mergeActivityEntries([row({ id: 'paid', txid: tx(1), origin: 'shop.example', sats: 100, at: 1 })])
    publishActivityLedger('ns', [ledgerCoin(1)])

    expect(listActivityFeed(10).map((e) => e.id)).toEqual(['paid'])
    expect(getActivityById(`ledger:${tx(1)}`)).toMatchObject({ id: `ledger:${tx(1)}`, origin: 'shop.example', sats: 100 })
  })

  it('keeps an open ledger-only item linked to its later annotation', () => {
    const outpoint = `${tx(1)}.0`
    publishActivityLedger('ns', [ledgerItem(2, outpoint, 'earned')])
    const id = `ledger:${tx(2)}:${outpoint}`
    const before = getActivityById(id)
    mergeActivityEntries([row({ id: 'named', txid: tx(2), kind: 'earned', method: 'receive-collectable', item: { name: 'Fox', origin: `${tx(1)}_0`, outpoint } })])
    const after = getActivityById(id)
    expect(after).toMatchObject({ id, item: { name: 'Fox', outpoint } })
    expect(sameActivityRow(before, after)).toBe(false)
  })

  it('does not treat a changed name, note, origin or token amount as the same display row', () => {
    const before = row({ id: 'row', item: { name: 'Fox', origin: 'asset', amt: '1' } })
    for (const after of [
      { ...before, note: 'Updated' }, { ...before, origin: 'app.example' },
      { ...before, item: { ...before.item!, name: 'Robot' } },
      { ...before, item: { ...before.item!, amt: '2' } },
    ]) expect(sameActivityRow(before, after)).toBe(false)
  })

  it('keeps both activities of a send to yourself', () => {
    mergeActivityEntries([
      row({ id: 'out', txid: tx(1), kind: 'spent', sats: 10_000 }),
      row({ id: 'in', txid: tx(1), kind: 'earned', method: 'receive', sats: 10_000 }),
    ])
    publishActivityLedger('ns', [ledgerCoin(1, { sats: 40 })])

    expect(listActivityFeed(10).map((e) => e.id).sort()).toEqual(['in', 'out'])
  })

  it('fills in the leg of an item move the store is missing', () => {
    const sent = `${tx(1)}.0`
    const received = `${tx(2)}.0`
    mergeActivityEntries([
      row({
        id: 'send-fox',
        txid: tx(2),
        method: 'send-collectable',
        item: { name: 'Fox', origin: `${tx(1)}_0`, outpoint: sent },
      }),
    ])
    publishActivityLedger('ns', [ledgerItem(2, sent, 'spent'), ledgerItem(2, received, 'earned')])

    expect(listActivityFeed(10).map((e) => e.id).sort()).toEqual([
      `ledger:${tx(2)}:${received}`,
      'send-fox',
    ])
  })

  it('hides one ledger row for good without hiding its siblings', () => {
    const a = `${tx(1)}.0`
    const b = `${tx(1)}.1`
    publishActivityLedger('ns', [ledgerItem(1, a, 'earned'), ledgerItem(1, b, 'earned')])

    expect(removeActivityById(`ledger:${tx(1)}:${a}`)).toBe(true)

    expect(listActivityFeed(10).map((e) => e.id)).toEqual([`ledger:${tx(1)}:${b}`])
    publishActivityLedger('ns', [ledgerItem(1, a, 'earned'), ledgerItem(1, b, 'earned'), ledgerCoin(9)])
    expect(listActivityFeed(10).map((e) => e.id)).not.toContain(`ledger:${tx(1)}:${a}`)
  })

  it('files a late annotation at the time the transaction happened', () => {
    publishActivityLedger('ns', [ledgerCoin(7, { at: 1_700_000_000_000 })])

    upsertAppActivity({ origin: 'shop.example', kind: 'spent', sats: 100, method: 'send', txid: tx(7) })

    expect(listActivityFeed(10)).toEqual([
      expect.objectContaining({ origin: 'shop.example', txid: tx(7), at: 1_700_000_000_000 }),
    ])
  })

  it('never moves a collectable in time when it finishes verifying', () => {
    const outpoint = `${tx(3)}.0`
    vi.setSystemTime(1_000)
    noteInboundReceivePending({ txid: tx(3), item: true, outpoint })
    vi.setSystemTime(2_000)
    upsertAppActivity({ origin: 'handcash', kind: 'earned', sats: 50, method: 'receive', txid: tx(4) })
    vi.setSystemTime(9_000)
    noteInboundReceiveComplete({ txid: tx(3), item: true, itemName: 'Fox', outpoint })

    expect(listActivityFeed(10).map((e) => [e.txid, e.at, e.note])).toEqual([
      [tx(4), 2_000, undefined],
      [tx(3), 1_000, 'Received Fox'],
    ])
  })

  it('keeps a ledger-only collectable in place when verification names it', () => {
    const outpoint = `${tx(5)}.0`
    publishActivityLedger('ns', [{ ...ledgerItem(5, outpoint, 'earned'), at: 1_500 }, ledgerCoin(6, { at: 2_500 })])
    vi.setSystemTime(9_000)

    noteInboundReceiveComplete({ txid: tx(5), item: true, itemName: 'Fox', outpoint })

    expect(listActivityFeed(10).map((e) => [e.txid, e.at, e.note])).toEqual([
      [tx(6), 2_500, 'Sent'],
      [tx(5), 1_500, 'Received Fox'],
    ])
  })

  it('sheds only rows the ledger still shows when storage is full', () => {
    const ledger = Array.from({ length: 1_100 }, (_, i) => ledgerCoin(i + 10))
    publishActivityLedger('ns', ledger)
    mergeActivityEntries([
      row({ id: 'self-out', txid: tx(1), at: 5, sats: 5_000 }),
      row({ id: 'self-in', txid: tx(1), at: 5, kind: 'earned', method: 'receive', sats: 5_000 }),
      ...ledger.map((l, i) => row({ id: `plain-${i}`, txid: l.txid, at: l.at, sats: 100 })),
    ])

    const kept = exportAllActivity()
    expect(kept).toHaveLength(1_000)
    expect(kept.map((e) => e.id)).toEqual(expect.arrayContaining(['self-out', 'self-in', 'plain-1099']))
    expect(listActivityFeed(5_000)).toHaveLength(1_102)
  })
})
