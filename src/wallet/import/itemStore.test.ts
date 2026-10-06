import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetImportItemStoreForTests,
  countImportItems,
  decidedImportOutpoints,
  forgetImportItemStore,
  groupImportOutpoints,
  markImportOutpointsGone,
  pruneImportItems,
  readImportGroups,
  readImportItemPage,
  readImportListMeta,
  readStoredImportItem,
  replaceAddressItems,
  saveImportItems,
  writeImportListMeta,
  type StoredImportItem,
} from './itemStore'

const op = (n: number) => `${n.toString(16).padStart(64, '0')}_0`
const SIGNER = '1BHLmsoMt4J4oyKbpPu2PoBDiP8C5h2sQx'

function item(n: number, over: Partial<StoredImportItem> = {}): StoredImportItem {
  return {
    outpoint: op(n),
    address: '1a',
    origin: op(n),
    media: op(n),
    name: `Item ${n}`,
    mimeType: 'image/png',
    app: null,
    collectionId: null,
    signer: null,
    ...over,
  }
}

const outpoints = (items: readonly StoredImportItem[]) => items.map((i) => i.outpoint)

beforeEach(async () => {
  await __resetImportItemStoreForTests()
})

describe('saved import items', () => {
  it('keeps found order, never relists a saved or gone outpoint, and pages after `last`', async () => {
    expect(outpoints(await saveImportItems('s', [item(1), item(2), item(1)]))).toEqual([op(1), op(2)])
    await markImportOutpointsGone('s', [op(3)])
    expect(outpoints(await saveImportItems('s', [item(2), item(3), item(4)]))).toEqual([op(4)])

    const first = await readImportItemPage('s', { after: null, limit: 2 })
    expect(outpoints(first.items)).toEqual([op(1), op(2)])
    expect(first.more).toBe(true)
    const rest = await readImportItemPage('s', { after: first.last, limit: 2 })
    expect(outpoints(rest.items)).toEqual([op(4)])
    expect(rest.more).toBe(false)
    expect(await countImportItems('s')).toBe(3)
    expect(await decidedImportOutpoints('s')).toEqual(new Set([op(1), op(2), op(3), op(4)]))
  })

  it('searches the name, the app and the start of the outpoint', async () => {
    await saveImportItems('s', [
      item(1, { name: 'Golden Dragon' }),
      item(2, { name: 'Silver', app: 'Dragonverse' }),
      item(3, { name: 'Plain' }),
    ])
    expect(outpoints((await readImportItemPage('s', { after: null, limit: 10, query: 'dragon' })).items)).toEqual([
      op(1),
      op(2),
    ])
    expect(outpoints((await readImportItemPage('s', { after: null, limit: 10, query: op(3).slice(0, 64) })).items)).toEqual([
      op(3),
    ])
  })

  it('shelves items by signer, then app, then collection, with counts and image faces', async () => {
    await saveImportItems('s', [
      item(1, { app: 'zoo', signer: SIGNER }),
      item(2, { app: 'zoo', signer: SIGNER, mimeType: 'text/plain' }),
      item(3, { app: 'Alpha' }),
      item(4, { collectionId: 'C1', name: 'Fox #4' }),
      item(5),
      ...[6, 7, 8, 9, 10].map((n) => item(n, { app: 'zoo', signer: SIGNER })),
    ])
    const shelves = await readImportGroups('s')
    expect(shelves.map((s) => [s.key, s.label, s.count])).toEqual([
      [`signer:${SIGNER}`, 'zoo', 7],
      ['app:alpha', 'Alpha', 1],
      ['collection:c1', 'Fox', 1],
      ['none', 'No issuer', 1],
    ])
    expect(outpoints(shelves[0]!.faces)).toEqual([op(1), op(6), op(7), op(8)])

    const page = await readImportItemPage('s', { after: null, limit: 3, group: `signer:${SIGNER}` })
    expect(outpoints(page.items)).toEqual([op(1), op(2), op(6)])
    expect(page.more).toBe(true)
    expect(await groupImportOutpoints('s', 'app:alpha')).toEqual([op(3)])
    expect(await readStoredImportItem('s', op(4))).toMatchObject({ collectionId: 'C1' })

    await markImportOutpointsGone('s', [op(3)])
    expect((await readImportGroups('s')).map((s) => s.key)).not.toContain('app:alpha')
  })

  it('prunes what the source no longer names, except at addresses listed in full', async () => {
    await saveImportItems('s', [item(1), item(2, { address: '1b' }), item(3)])
    await markImportOutpointsGone('s', [op(8), op(9)])
    expect(await pruneImportItems('s', new Set([op(1), op(9)]), new Set(['1b']))).toEqual([op(3)])
    expect(outpoints((await readImportItemPage('s', { after: null, limit: 10 })).items)).toEqual([op(1), op(2)])
    expect(await decidedImportOutpoints('s')).toEqual(new Set([op(1), op(2), op(9)]))
  })

  it('makes an address listed in full hold exactly what its pages showed', async () => {
    await saveImportItems('s', [item(1), item(2), item(3, { address: '1b' })])
    const { removed, added } = await replaceAddressItems('s', '1a', [item(2), item(4)])
    expect(removed).toEqual([op(1)])
    expect(outpoints(added)).toEqual([op(4)])
    expect(outpoints((await readImportItemPage('s', { after: null, limit: 10 })).items)).toEqual([op(2), op(3), op(4)])
  })

  it('keeps sources apart and forgets one with its scan marks', async () => {
    await saveImportItems('s', [item(1)])
    await saveImportItems('t', [item(1), item(2)])
    await writeImportListMeta('s', { scanAt: 7, complete: true, pagedAddresses: ['1a'] })
    expect(await readImportListMeta('s')).toMatchObject({ scanAt: 7, complete: true, pagedAddresses: ['1a'], nextSeq: 1 })
    await forgetImportItemStore('s')
    expect(await countImportItems('s')).toBe(0)
    expect(await readImportGroups('s')).toEqual([])
    expect(await readImportListMeta('s')).toMatchObject({ scanAt: 0, pagedAddresses: [] })
    expect(await countImportItems('t')).toBe(2)
  })
})
