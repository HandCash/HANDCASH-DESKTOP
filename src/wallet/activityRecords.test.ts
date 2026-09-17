import { describe, expect, it } from 'vitest'
import {
  activityBatchName,
  batchSiblingsForEntry,
  composeActivityRecords,
} from './activityRecords'
import type { ActivityEntry } from './appActivity'

const WALLET = 'handcash.wallet'
const TXID = 'ab'.repeat(32)
const OTHER_TXID = 'cd'.repeat(32)

function entry(overrides: Partial<ActivityEntry> & { method: string }): ActivityEntry {
  return {
    id: `${overrides.method}-${Math.random().toString(16).slice(2)}`,
    origin: WALLET,
    kind: 'earned',
    sats: 1,
    at: 1,
    ...overrides,
  } as ActivityEntry
}

/** One collectable leg of {@link TXID}, distinct by vout. */
function collectable(
  name: string,
  vout: number,
  overrides: Partial<ActivityEntry> = {},
): ActivityEntry {
  return entry({
    method: 'receive-collectable',
    txid: TXID,
    item: {
      name,
      origin: `${OTHER_TXID}_${vout}`,
      outpoint: `${TXID}.${vout}`,
    },
    ...overrides,
  })
}

describe('composeActivityRecords', () => {
  it('folds a listing and the held item it created into one record', () => {
    const records = composeActivityRecords([
      entry({
        method: 'market-list',
        kind: 'event',
        sats: 0,
        txid: TXID,
        item: { name: 'Fox', origin: `${OTHER_TXID}_0`, outpoint: `${TXID}.0` },
      }),
      entry({
        method: 'receive-collectable',
        txid: TXID,
        item: { name: 'Fox', origin: `${OTHER_TXID}_0`, outpoint: `${TXID}.0` },
      }),
    ])
    expect(records).toHaveLength(1)
    expect(records[0]!.subject.method).toBe('market-list')
    expect(records[0]!.assets).toEqual([])
    expect(records[0]!.entries).toHaveLength(2)
  })

  it('prices a purchase from the money leg and names it from the received item', () => {
    const records = composeActivityRecords([
      entry({ method: 'market-purchase', kind: 'spent', sats: 9_000, txid: TXID }),
      entry({
        method: 'market-purchase-receive',
        sats: 1,
        txid: TXID,
        item: { name: 'Fox', origin: `${OTHER_TXID}_0`, outpoint: `${TXID}.0` },
      }),
    ])
    expect(records).toHaveLength(1)
    expect(records[0]!.subject.method).toBe('market-purchase-receive')
    expect(records[0]!.money?.method).toBe('market-purchase')
    expect(records[0]!.money?.sats).toBe(9_000)
  })

  it('folds sale proceeds under the sold item', () => {
    const records = composeActivityRecords([
      entry({
        method: 'market-sale',
        kind: 'spent',
        sats: 1,
        txid: TXID,
        item: { name: 'Fox', origin: `${OTHER_TXID}_0`, outpoint: `${OTHER_TXID}.0` },
      }),
      entry({ method: 'market-sale-proceeds', sats: 8_550, txid: TXID }),
    ])
    expect(records).toHaveLength(1)
    expect(records[0]!.subject.method).toBe('market-sale')
    expect(records[0]!.money?.sats).toBe(8_550)
    expect(records[0]!.assets).toEqual([])
  })

  it('prices a purchase from the price, not from a coin row on the same tx', () => {
    const records = composeActivityRecords([
      entry({ method: 'receive', sats: 220, txid: TXID }),
      entry({ method: 'market-purchase', kind: 'spent', sats: 9_000, txid: TXID }),
      entry({
        method: 'market-purchase-receive',
        txid: TXID,
        item: { name: 'Fox', origin: `${OTHER_TXID}_0`, outpoint: `${TXID}.0` },
      }),
    ])
    expect(records[0]!.money?.method).toBe('market-purchase')
  })

  it('keeps one row per distinct asset inside a single multi-asset record', () => {
    const records = composeActivityRecords([
      entry({
        method: 'receive-collectable',
        txid: TXID,
        item: { name: 'Fox', origin: `${OTHER_TXID}_0`, outpoint: `${TXID}.0` },
      }),
      entry({
        method: 'receive-collectable',
        txid: TXID,
        item: { name: 'Bear', origin: `${OTHER_TXID}_1`, outpoint: `${TXID}.1` },
      }),
      entry({
        method: 'receive-collectable',
        txid: TXID,
        item: { name: 'Owl', origin: `${OTHER_TXID}_2`, outpoint: `${TXID}.2` },
      }),
    ])
    expect(records).toHaveLength(1)
    expect(records[0]!.assets.map((row) => row.item?.name)).toEqual(['Bear', 'Owl'])
  })

  it('names a batch by its shared series, not by one of its members', () => {
    const records = composeActivityRecords([
      collectable('Pixel Foxes #8413557', 0),
      collectable('Pixel Foxes #9412777', 1),
      collectable('Pixel Foxes #9412755', 2),
    ])
    expect(records).toHaveLength(1)
    expect(records[0]!.batch).toEqual({ count: 3, label: 'Pixel Foxes' })
    expect(activityBatchName(records[0]!.batch!)).toBe('3 Pixel Foxes')
  })

  it('speaks a singular series as a plural once it is a batch', () => {
    const records = composeActivityRecords([
      collectable('Fox #1', 0),
      collectable('Fox #2', 1),
    ])
    expect(activityBatchName(records[0]!.batch!)).toBe('2 Foxes')
  })

  it('will not claim a series the members do not share', () => {
    const records = composeActivityRecords([
      collectable('Fox #1', 0),
      collectable('Bear #4', 1),
    ])
    expect(records[0]!.batch).toEqual({ count: 2, label: null })
    expect(activityBatchName(records[0]!.batch!)).toBe('2 collectables')
  })

  it('leaves a single collectable unbatched', () => {
    const records = composeActivityRecords([collectable('Pixel Foxes #8413557', 0)])
    expect(records[0]!.batch).toBeNull()
  })

  it('does not batch a market record around its money leg', () => {
    const records = composeActivityRecords([
      entry({ method: 'market-purchase', kind: 'spent', sats: 9_000, txid: TXID }),
      collectable('Pixel Foxes #8413557', 0, { method: 'market-purchase-receive' }),
    ])
    expect(records[0]!.batch).toBeNull()
  })

  it('spells out the other members for the detail view', () => {
    const entries = [
      collectable('Pixel Foxes #8413557', 0),
      collectable('Pixel Foxes #9412777', 1),
      collectable('Pixel Foxes #9412755', 2),
    ]
    expect(
      batchSiblingsForEntry(entries[0]!, entries).map((row) => row.item?.name),
    ).toEqual(['Pixel Foxes #9412777', 'Pixel Foxes #9412755'])
  })

  it('never folds a failed leg, a different transaction, or a different origin', () => {
    const records = composeActivityRecords([
      entry({ method: 'send-collectable', kind: 'spent', sats: 1, txid: TXID, status: 'failed' }),
      entry({ method: 'market-purchase', kind: 'spent', sats: 9_000, txid: TXID }),
      entry({ method: 'market-purchase', kind: 'spent', sats: 7_000, txid: OTHER_TXID }),
      entry({ method: 'market-purchase', kind: 'spent', sats: 9_000, txid: TXID, origin: 'market.handcash.io' }),
    ])
    expect(records).toHaveLength(4)
  })

  it('keeps a self-send as the two facts it is, not one joined record', () => {
    const records = composeActivityRecords([
      entry({ method: 'send', kind: 'spent', sats: 5_000, txid: TXID }),
      entry({ method: 'receive', kind: 'earned', sats: 5_000, txid: TXID }),
    ])
    expect(records).toHaveLength(2)
    expect(records.map((record) => record.subject.method)).toEqual([
      'send',
      'receive',
    ])
    // Neither leg may be demoted to the other's price.
    expect(records.every((record) => record.money === null)).toBe(true)
  })

  it('still folds same-direction legs of an ordinary transaction', () => {
    const records = composeActivityRecords([
      entry({
        method: 'send-collectable',
        kind: 'spent',
        sats: 1,
        txid: TXID,
        item: { name: 'Fox', origin: `${OTHER_TXID}_0`, outpoint: `${OTHER_TXID}.0` },
      }),
      entry({ method: 'send', kind: 'spent', sats: 4_000, txid: TXID }),
    ])
    expect(records).toHaveLength(1)
    expect(records[0]!.subject.method).toBe('send-collectable')
    expect(records[0]!.money?.sats).toBe(4_000)
  })

  it('leaves entries without a txid as their own records', () => {
    const records = composeActivityRecords([
      entry({ method: 'connect', kind: 'event', sats: 0 }),
      entry({ method: 'add-friend', kind: 'event', sats: 0 }),
    ])
    expect(records).toHaveLength(2)
  })

  it('preserves feed order by first appearance', () => {
    const records = composeActivityRecords([
      entry({ method: 'market-purchase', kind: 'spent', sats: 9_000, txid: TXID, at: 5 }),
      entry({ method: 'receive', sats: 100, txid: OTHER_TXID, at: 4 }),
      entry({
        method: 'market-purchase-receive',
        txid: TXID,
        at: 5,
        item: { name: 'Fox', origin: `${OTHER_TXID}_0`, outpoint: `${TXID}.0` },
      }),
    ])
    expect(records.map((record) => record.subject.method)).toEqual([
      'market-purchase-receive',
      'receive',
    ])
  })
})
