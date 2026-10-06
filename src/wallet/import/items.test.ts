import { PrivateKey } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../appLog', () => ({ appendAppLog: vi.fn(), setStallContextProvider: vi.fn() }))
vi.mock('../yieldToUi', () => ({ yieldToUi: async () => undefined, uiBudgetExpired: () => false }))
const active = { chain: 'main' as const, identityKey: PrivateKey.fromRandom().toPublicKey().toString() }
vi.mock('../walletRuntime', () => ({ getWalletRuntime: () => ({ instance: active }) }))
vi.mock('./store', () => ({ loadImportedSources: vi.fn(), updateImportedSource: vi.fn() }))
vi.mock('../phraseSweep', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../phraseSweep')>()),
  migrateOnePhraseItem: vi.fn(),
  peekPhraseItemMigrateCursor: vi.fn(() => null),
}))
vi.mock('./handcashUtxoSet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./handcashUtxoSet')>()),
  fetchHandCashUtxoSet: vi.fn(),
}))

import { migrateOnePhraseItem, peekPhraseItemMigrateCursor } from '../phraseSweep'
import { fetchHandCashUtxoSet } from './handcashUtxoSet'
import { emptyHoldings, type AddressHoldings } from './holdings'
import { forgetImportItems, importOneItem, listImportItems, rememberImportItems, type ImportItem } from './items'
import { loadImportedSources, updateImportedSource, type ImportedSource } from './store'

const op = (n: number) => `${n.toString(16).padStart(64, '0')}_0`
const holding = (address: string, itemCount: number, extra: Partial<AddressHoldings> = {}): AddressHoldings => ({
  ...emptyHoldings({ address, path: 'wif:0', label: 'Private key', wallets: 'Private key', uncompressed: false }),
  itemCount,
  ...extra,
})
const item = (n: number, address: string): ImportItem => ({
  outpoint: op(n),
  address,
  origin: op(n),
  media: op(n),
  name: `Item ${n}`,
  mimeType: 'image/png',
  imageUrl: null,
})

function source(holdings: AddressHoldings[], via?: 'handcash-utxo-set'): ImportedSource {
  return {
    id: 's1',
    kind: 'handcash',
    label: 'HandCash',
    createdAt: 1,
    fingerprint: 'f',
    secret: { kind: 'wif', wifs: [PrivateKey.fromRandom().toWif()] },
    handle: null,
    scan: { at: 42, complete: true, checked: holdings.length, addresses: [], holdings, ...(via ? { via } : {}) },
    lastSweep: null,
  } as unknown as ImportedSource
}

beforeEach(() => {
  forgetImportItems('s1')
  vi.mocked(loadImportedSources).mockReset()
  vi.mocked(updateImportedSource).mockReset()
  vi.mocked(migrateOnePhraseItem).mockReset()
  vi.mocked(fetchHandCashUtxoSet).mockReset()
  vi.mocked(peekPhraseItemMigrateCursor).mockReturnValue(null)
})

describe('listImportItems', () => {
  it('reuses the scan’s list and pages only addresses it does not cover', async () => {
    vi.mocked(loadImportedSources).mockResolvedValue([source([holding('1a', 1), holding('1b', 2)], 'handcash-utxo-set')])
    rememberImportItems('s1', 42, { items: [item(1, '1a')], complete: true })
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/txos/address/1b/unspent?limit=100&offset=0')
      return new Response(
        JSON.stringify([
          { outpoint: op(2), satoshis: 1, spend: '' },
          { outpoint: op(3), satoshis: 1, spend: '' },
          { outpoint: op(4), satoshis: 5_000, spend: '' },
          { outpoint: op(1), satoshis: 1, spend: '' },
        ]),
      )
    })
    const batches: string[][] = []
    const list = await listImportItems({
      sourceId: 's1',
      fetchImpl,
      onItems: (items) => batches.push(items.map((i) => i.outpoint)),
    })
    expect(batches).toEqual([[op(1)], [op(2), op(3)]])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchHandCashUtxoSet).not.toHaveBeenCalled()
    expect(list.complete).toBe(true)
    expect(list.items.map((i) => [i.outpoint, i.address])).toEqual([
      [op(1), '1a'],
      [op(2), '1b'],
      [op(3), '1b'],
    ])
    expect(list.items[0].imageUrl).toBe(`https://ordinals.gorillapool.io/content/${op(1)}`)
  })

  it('marks the list incomplete when an address page cannot be read', async () => {
    vi.mocked(loadImportedSources).mockResolvedValue([source([holding('1a', 1)])])
    const list = await listImportItems({
      sourceId: 's1',
      fetchImpl: vi.fn(async () => new Response('busy', { status: 503 })),
    })
    expect(list).toEqual({ items: [], complete: false })
  })

  it('does not keep a stopped run', async () => {
    vi.mocked(loadImportedSources).mockResolvedValue([source([holding('1a', 1)])])
    const list = await listImportItems({ sourceId: 's1', fetchImpl: vi.fn(), shouldStop: () => true })
    expect(list).toEqual({ items: [], complete: false })
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{ outpoint: op(5), satoshis: 1, spend: '' }])))
    expect((await listImportItems({ sourceId: 's1', fetchImpl })).items.map((i) => i.outpoint)).toEqual([op(5)])
  })

  it('reads a HandCash set without re-deriving the paths the last scan saved', async () => {
    const s = source([holding('1a', 0)], 'handcash-utxo-set')
    const key = PrivateKey.fromRandom()
    const address = key.toAddress()
    const lock = `76a914${key.toPublicKey().toHash('hex') as string}88ac`
    s.scan!.addresses = [{ path: 'm/9/4', address, label: 'HandCash items', wallets: 'HandCash' }]
    s.scan!.holdings = [holding(address, 1)]
    vi.mocked(loadImportedSources).mockResolvedValue([s])
    vi.mocked(fetchHandCashUtxoSet).mockResolvedValue({
      kind: 'fetched',
      utxos: [
        { txid: '7'.repeat(64), vout: 0, satoshis: 1, script: lock, address, path: 'm/9/4', type: 'standard', status: 'available', height: 1 },
      ],
    })
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify([{ outpoint: `${'7'.repeat(64)}_0`, spend: '', origin: null, data: null }])),
    )
    const list = await listImportItems({ sourceId: 's1', fetchImpl })
    expect(list.items.map((i) => [i.outpoint, i.address])).toEqual([[`${'7'.repeat(64)}_0`, address]])
  })

  it('refuses an unscanned source', async () => {
    vi.mocked(loadImportedSources).mockResolvedValue([{ ...source([]), scan: null }])
    await expect(listImportItems({ sourceId: 's1' })).rejects.toThrow('Scan this wallet first')
  })
})

describe('importOneItem', () => {
  it('moves the chosen item on its address key and counts it out of the scan', async () => {
    const s = source([holding('1a', 2)])
    vi.mocked(loadImportedSources).mockResolvedValue([s])
    rememberImportItems('s1', 42, { items: [item(1, '1a'), item(2, '1a')], complete: true })
    vi.mocked(migrateOnePhraseItem).mockResolvedValue({ kind: 'moved', txid: 'f'.repeat(64) })

    expect(await importOneItem({ sourceId: 's1', item: item(1, '1a') })).toEqual({ kind: 'moved', txid: 'f'.repeat(64) })
    const call = vi.mocked(migrateOnePhraseItem).mock.calls[0][0]
    expect(call).toMatchObject({ outpoint: op(1), origin: op(1), name: 'Item 1', candidate: { address: '1a', scheme: 'import' } })
    expect(vi.mocked(updateImportedSource).mock.calls[0][1].scan?.holdings[0].itemCount).toBe(1)

    vi.mocked(loadImportedSources).mockResolvedValue([source([holding('1a', 1)])])
    const left = await listImportItems({ sourceId: 's1', fetchImpl: vi.fn() })
    expect(left.items.map((i) => i.outpoint)).toEqual([op(2)])
  })

  it('refuses while a paused sweep reads the same address, and for unknown addresses', async () => {
    vi.mocked(loadImportedSources).mockResolvedValue([source([holding('1a', 1)])])
    vi.mocked(peekPhraseItemMigrateCursor).mockReturnValue({ sourceAddress: '1a' } as never)
    expect(await importOneItem({ sourceId: 's1', item: item(1, '1a') })).toMatchObject({
      kind: 'refused',
      reason: 'pausedBatch',
    })
    expect(await importOneItem({ sourceId: 's1', item: item(1, '1z') })).toMatchObject({ kind: 'refused', reason: 'gone' })
    expect(migrateOnePhraseItem).not.toHaveBeenCalled()
  })

  it('leaves the scan alone when the move did not happen', async () => {
    vi.mocked(loadImportedSources).mockResolvedValue([source([holding('1a', 1)])])
    vi.mocked(migrateOnePhraseItem).mockResolvedValue({ kind: 'funds', message: 'low' })
    expect(await importOneItem({ sourceId: 's1', item: item(1, '1a') })).toMatchObject({ kind: 'funds' })
    expect(updateImportedSource).not.toHaveBeenCalled()
  })
})
