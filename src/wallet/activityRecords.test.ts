import { describe, expect, it } from 'vitest'
import {
  activityBatchName,
  ACTIVITY_COMPOSE_WINDOW,
  previewActivityRecords,
  composeActivityRecords,
  batchSiblingsForEntry,
  unfoldLiveJobLegs,
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
  it('never hands a feed two records under one key', () => {
    // Same spent txid written by an app origin and by the wallet: two records
    // by origin, one subject key. React must still see distinct keys.
    const records = composeActivityRecords([
      entry({ method: 'createAction', kind: 'spent', sats: 700, txid: TXID, origin: 'demo.app', id: 'app-row' }),
      entry({ method: 'send', kind: 'spent', sats: 700, txid: TXID, id: 'wallet-row' }),
    ])
    expect(records).toHaveLength(2)
    expect(new Set(records.map((record) => record.key)).size).toBe(2)
    expect(records[0]?.key).toBe(`tx:${TXID}:spent`)
    expect(records[1]?.key).toBe(`tx:${TXID}:spent~wallet-row`)
  })

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

  it('calls one listed item one item when its legs agree on only one key', () => {
    // The listing event knows the genesis origin and the outpoint it created;
    // the held leg only knows the outpoint. One fox, one key in common.
    const records = composeActivityRecords([
      entry({
        method: 'market-list',
        kind: 'event',
        sats: 0,
        txid: TXID,
        item: { name: 'Fox #12', origin: `${OTHER_TXID}_0`, outpoint: `${TXID}.0` },
      }),
      entry({
        method: 'receive-collectable',
        txid: TXID,
        item: { name: 'Fox #12', origin: '', outpoint: `${TXID}.0` },
      }),
    ])
    expect(records).toHaveLength(1)
    expect(records[0]!.assets).toEqual([])
    expect(records[0]!.batch).toBeNull()
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

  it('keeps a self-buy as listed, bought, and sold', () => {
    const token = {
      name: 'KING',
      origin: `${OTHER_TXID}_0`,
      tokenId: `${OTHER_TXID}_0`,
      outpoint: `${OTHER_TXID}.0`,
      icon: `${OTHER_TXID}_1`,
    }
    const records = composeActivityRecords([
      entry({
        method: 'market-list',
        kind: 'event',
        txid: OTHER_TXID,
        item: token,
      }),
      entry({ method: 'market-purchase', kind: 'spent', sats: 9_000, txid: TXID }),
      entry({
        method: 'market-purchase-receive',
        txid: TXID,
        item: { ...token, outpoint: `${TXID}.0` },
      }),
      entry({
        method: 'market-sale',
        kind: 'spent',
        sats: 1,
        txid: TXID,
        item: token,
      }),
      entry({ method: 'market-sale-proceeds', sats: 8_550, txid: TXID }),
    ])
    expect(records.map((row) => row.subject.method)).toEqual([
      'market-list',
      'market-purchase-receive',
      'market-sale',
    ])
    expect(records[1]!.money?.method).toBe('market-purchase')
    expect(records[2]!.money?.method).toBe('market-sale-proceeds')
    expect(records[1]!.subject.item?.icon).toBe(`${OTHER_TXID}_1`)
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

  it.each([
    ['pending', undefined],
    ['complete', TXID],
    ['failed', undefined],
  ] as const)(
    'keeps a grouped NFT burn as one %s record with every member',
    (status, txid) => {
      const legs = ['Pixel Foxes #1', 'Pixel Foxes #2', 'Pixel Foxes #3'].map(
        (name, vout) =>
          entry({
            method: 'burn-collectable',
            kind: 'spent',
            status,
            ...(txid ? { txid } : {}),
            pendingId: `burn-group-${vout}`,
            sendGroupId: 'burn-group',
            burn: { asset: '1sat', destroyedAmount: '1' },
            item: {
              name,
              origin: `${OTHER_TXID}_${vout}`,
              outpoint: `${OTHER_TXID}.${vout}`,
            },
          }),
      )

      const records = composeActivityRecords(legs)

      expect(records).toHaveLength(1)
      expect(records[0]!.entries).toHaveLength(3)
      expect(records[0]!.batch).toEqual({ count: 3, label: 'Pixel Foxes' })
      expect(activityBatchName(records[0]!.batch!)).toBe('3 Pixel Foxes')
    },
  )

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

  it('does not treat a pending placeholder as a second collectable', () => {
    const records = composeActivityRecords([
      collectable('Pixel Foxes #8413557', 0),
      entry({
        method: 'receive-collectable',
        txid: TXID,
        status: 'pending',
        item: { name: 'Pixel Foxes #8413557', origin: `${TXID}_pending` },
      }),
    ])
    expect(records).toHaveLength(1)
    expect(records[0]!.batch).toBeNull()
    expect(records[0]!.assets).toEqual([])
  })

  it('treats origin dotted vs underscored as the same inscription', () => {
    const records = composeActivityRecords([
      collectable('Pixel Foxes #8413557', 0),
      entry({
        method: 'receive-collectable',
        txid: TXID,
        item: {
          name: 'Pixel Foxes #8413557',
          origin: `${OTHER_TXID}.0`,
          outpoint: `${TXID}.0`,
        },
      }),
    ])
    expect(records[0]!.batch).toBeNull()
    expect(records[0]!.assets).toEqual([])
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

  it('folds the pending legs of one batch send before any txid exists', () => {
    const leg = (name: string, vout: number) =>
      entry({
        method: 'send-collectable',
        kind: 'spent',
        sats: 1,
        status: 'pending',
        pendingId: `pending-${vout}`,
        sendGroupId: 'batch-abc',
        item: {
          name,
          origin: `${OTHER_TXID}_${vout}`,
          outpoint: `${OTHER_TXID}.${vout}`,
        },
      })
    const records = composeActivityRecords([
      leg('Pixel Foxes #1', 0),
      leg('Pixel Foxes #2', 1),
      leg('Pixel Foxes #3', 2),
    ])

    expect(records).toHaveLength(1)
    expect(records[0]!.batch).toEqual({ count: 3, label: 'Pixel Foxes' })
    expect(activityBatchName(records[0]!.batch!)).toBe('3 Pixel Foxes')
    // Nothing is dropped: every leg stays individually addressable.
    expect(records[0]!.entries).toHaveLength(3)
  })

  it('keeps pending sends of different batches apart', () => {
    const leg = (group: string, vout: number) =>
      entry({
        method: 'send-collectable',
        kind: 'spent',
        sats: 1,
        status: 'pending',
        sendGroupId: group,
        item: {
          name: 'Fox',
          origin: `${OTHER_TXID}_${vout}`,
          outpoint: `${OTHER_TXID}.${vout}`,
        },
      })
    const records = composeActivityRecords([
      leg('batch-one', 0),
      leg('batch-two', 1),
    ])
    expect(records).toHaveLength(2)
  })

  it('never folds a failed leg into its batch — it is cleared on its own', () => {
    const records = composeActivityRecords([
      entry({
        method: 'send-collectable',
        kind: 'spent',
        sats: 1,
        status: 'pending',
        sendGroupId: 'batch-abc',
        item: { name: 'Fox', origin: `${OTHER_TXID}_0`, outpoint: `${OTHER_TXID}.0` },
      }),
      entry({
        method: 'send-collectable',
        kind: 'spent',
        sats: 1,
        status: 'failed',
        failureReason: 'rejected',
        sendGroupId: 'batch-abc',
        item: { name: 'Fox', origin: `${OTHER_TXID}_1`, outpoint: `${OTHER_TXID}.1` },
      }),
    ])
    expect(records).toHaveLength(2)
  })

  it('hands a settled batch over to the txid fold without splitting it', () => {
    const leg = (vout: number) =>
      entry({
        method: 'send-collectable',
        kind: 'spent',
        sats: 1,
        txid: TXID,
        // The group id survives the settle; the txid is what folds it now.
        sendGroupId: 'batch-abc',
        item: {
          name: 'Pixel Foxes #9',
          origin: `${OTHER_TXID}_${vout}`,
          outpoint: `${TXID}.${vout}`,
        },
      })
    const records = composeActivityRecords([leg(0), leg(1)])
    expect(records).toHaveLength(1)
    expect(records[0]!.batch?.count).toBe(2)
  })

  it('folds every row of one import run into one record across its transactions', () => {
    const imported = (name: string, txid: string, vout: number) =>
      entry({
        method: 'receive-collectable',
        txid,
        note: 'Imported collectable',
        sendGroupId: 'job:item-import:abc',
        item: { name, origin: `${OTHER_TXID}_${vout}`, outpoint: `${txid}.${vout}` },
      })
    const records = composeActivityRecords([
      imported('Pixel Foxes #1', TXID, 0),
      imported('Pixel Foxes #2', OTHER_TXID, 1),
      imported('Pixel Foxes #3', OTHER_TXID, 2),
      entry({
        method: 'receive-collectable',
        txid: TXID,
        sendGroupId: 'job:item-import:abc',
        status: 'failed',
        failureReason: 'fee coin spent',
        item: { name: 'Pixel Foxes #4', origin: `${OTHER_TXID}_3`, outpoint: `${TXID}.3` },
      }),
    ])
    expect(records).toHaveLength(2)
    expect(records[0]!.entries).toHaveLength(3)
    expect(records[0]!.batch).toEqual({ count: 3, label: 'Pixel Foxes' })
    expect(records[1]!.entries[0]!.status).toBe('failed')
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

  it('names a full batch when the preview slices records, not entries', () => {
    const foxes = Array.from({ length: 12 }, (_, i) =>
      collectable(`Pixel Foxes #${i + 1}`, i, { at: 1 }),
    )
    const newer = Array.from({ length: 6 }, (_, i) =>
      entry({
        method: 'receive',
        sats: 100,
        txid: `${'c'.repeat(62)}${i.toString(16).padStart(2, '0')}`,
        at: 10 + i,
      }),
    )
    const newestFifteen = [...newer, ...foxes]
      .sort((a, b) => b.at - a.at)
      .slice(0, 15)
    const truncated = composeActivityRecords(newestFifteen)
    const foxRow = truncated.find((row) => row.batch)
    expect(foxRow?.batch?.count).toBe(9)

    const preview = previewActivityRecords([...newer, ...foxes], 15)
    expect(preview.find((row) => row.batch)?.batch).toEqual({
      count: 12,
      label: 'Pixel Foxes',
    })
    expect(ACTIVITY_COMPOSE_WINDOW).toBeGreaterThan(15)
  })
})

describe('unfoldLiveJobLegs', () => {
  const JOB = 'job:item-import:abc'
  const legs = [
    collectable('Fox #1', 0, { sendGroupId: JOB, at: 1 }),
    collectable('Fox #2', 1, { sendGroupId: JOB, at: 1 }),
    collectable('Fox #3', 0, { sendGroupId: JOB, at: 2, txid: OTHER_TXID, item: { name: 'Fox #3', origin: `${TXID}_9`, outpoint: `${OTHER_TXID}.0` } }),
  ]

  it('shows each transaction of a running job as it lands', () => {
    const records = composeActivityRecords(unfoldLiveJobLegs(legs, new Set([JOB])))
    expect(records).toHaveLength(2)
    expect(records.map((record) => record.entries.length).sort()).toEqual([1, 2])
  })

  it('folds the legs into one record once the job leaves', () => {
    expect(unfoldLiveJobLegs(legs, new Set())).toBe(legs)
    expect(composeActivityRecords(legs)).toHaveLength(1)
  })
})
