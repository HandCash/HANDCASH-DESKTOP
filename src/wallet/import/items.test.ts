import 'fake-indexeddb/auto'
import { PrivateKey } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../appLog', () => ({ appendAppLog: vi.fn(), setStallContextProvider: vi.fn() }))
vi.mock('../yieldToUi', () => ({ yieldToUi: async () => undefined, uiBudgetExpired: () => false }))
const active = { chain: 'main' as const, identityKey: PrivateKey.fromRandom().toPublicKey().toString() }
vi.mock('../walletRuntime', () => ({ getWalletRuntime: () => ({ instance: active }) }))
vi.mock('./store', () => ({ loadImportedSources: vi.fn(), updateImportedSource: vi.fn() }))
vi.mock('../phraseSweep', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../phraseSweep')>()),
  migrateChosenPhraseItems: vi.fn(),
  peekPhraseItemMigrateCursor: vi.fn(() => null),
}))
vi.mock('./handcashUtxoSet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./handcashUtxoSet')>()),
  fetchHandCashUtxoSet: vi.fn(),
}))

import { migrateChosenPhraseItems, peekPhraseItemMigrateCursor, type SingleItemMigrate } from '../phraseSweep'
import { fetchHandCashUtxoSet } from './handcashUtxoSet'
import { emptyHoldings, type AddressHoldings } from './holdings'
import { __resetImportItemStoreForTests, saveImportItems, type StoredImportItem } from './itemStore'
import {
  importItems,
  readImportItems,
  readImportShelves,
  syncImportItems,
  type ImportItemChange,
} from './items'
import { loadImportedSources, updateImportedSource, type ImportedSource } from './store'

const op = (n: number) => `${n.toString(16).padStart(64, '0')}_0`
const holding = (address: string, itemCount: number, extra: Partial<AddressHoldings> = {}): AddressHoldings => ({
  ...emptyHoldings({ address, path: 'wif:0', label: 'Private key', wallets: 'Private key', uncompressed: false }),
  itemCount,
  ...extra,
})
const stored = (n: number, address: string): StoredImportItem => ({
  outpoint: op(n),
  address,
  origin: op(n),
  media: op(n),
  name: `Item ${n}`,
  mimeType: 'image/png',
  app: null,
  collectionId: null,
  signer: null,
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

/** The 1Sat index: each address's unspent rows, paged by `offset`. */
function addressIndex(rows: Record<string, unknown[]>) {
  return vi.fn(async (url: string) => {
    const address = /\/address\/([^/]+)\/unspent/.exec(url)?.[1] ?? ''
    if (!(address in rows)) return new Response('busy', { status: 503 })
    return new Response(JSON.stringify(rows[address]))
  })
}

const unspentRow = (n: number, extra: Record<string, unknown> = {}) => ({ outpoint: op(n), satoshis: 1, spend: '', ...extra })

async function listed(): Promise<string[]> {
  return (await readImportItems({ sourceId: 's1', after: null, limit: 100 })).items.map((i) => i.outpoint)
}

beforeEach(async () => {
  await __resetImportItemStoreForTests()
  vi.mocked(loadImportedSources).mockReset()
  vi.mocked(updateImportedSource).mockReset()
  vi.mocked(migrateChosenPhraseItems).mockReset()
  vi.mocked(fetchHandCashUtxoSet).mockReset()
  vi.mocked(peekPhraseItemMigrateCursor).mockReturnValue(null)
})

describe('syncImportItems', () => {
  it('saves each address’s items and does not page them again for the same scan', async () => {
    vi.mocked(loadImportedSources).mockResolvedValue([source([holding('1a', 2), holding('1b', 0)])])
    const fetchImpl = addressIndex({
      '1a': [unspentRow(1), unspentRow(2), { outpoint: op(3), satoshis: 5_000, spend: '' }, unspentRow(4, { spend: 'f' })],
    })
    const changes: ImportItemChange[] = []
    expect(await syncImportItems({ sourceId: 's1', fetchImpl, onChange: (c) => changes.push(c) })).toEqual({
      complete: true,
      total: 2,
    })
    expect(changes).toEqual([{ added: 2, gone: [] }])
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const again = addressIndex({})
    expect(await syncImportItems({ sourceId: 's1', fetchImpl: again })).toEqual({ complete: true, total: 2 })
    expect(again).not.toHaveBeenCalled()
    const page = await readImportItems({ sourceId: 's1', after: null, limit: 100 })
    expect(page.items.map((i) => i.outpoint)).toEqual([op(1), op(2)])
    expect(page.items[0]!.imageUrl).toBeNull()
  })

  it('keeps a stopped run’s progress and resumes with what is left', async () => {
    const addresses = ['1a', '1b', '1c', '1d', '1e']
    vi.mocked(loadImportedSources).mockResolvedValue([source(addresses.map((a) => holding(a, 1)))])
    const rows = Object.fromEntries(addresses.map((a, i) => [a, [unspentRow(i + 1)]]))
    const first = addressIndex(rows)
    const stopped = await syncImportItems({ sourceId: 's1', fetchImpl: first, shouldStop: () => first.mock.calls.length >= 4 })
    expect(stopped).toEqual({ complete: false, total: 4 })

    const second = addressIndex(rows)
    expect(await syncImportItems({ sourceId: 's1', fetchImpl: second })).toEqual({ complete: true, total: 5 })
    expect(second.mock.calls.map(([url]) => /address\/(\w+)\//.exec(url)?.[1])).toEqual(['1e'])
    expect(await listed()).toEqual([op(1), op(2), op(3), op(4), op(5)])
  })

  it('marks the list incomplete when an address page cannot be read', async () => {
    vi.mocked(loadImportedSources).mockResolvedValue([source([holding('1a', 1)])])
    expect(await syncImportItems({ sourceId: 's1', fetchImpl: addressIndex({}) })).toEqual({ complete: false, total: 0 })
  })

  it('checks a HandCash set by outpoint, asks only about new outputs, and keeps the list when the set is unavailable', async () => {
    const s = source([], 'handcash-utxo-set')
    const key = PrivateKey.fromRandom()
    const address = key.toAddress()
    const lock = `76a914${key.toPublicKey().toHash('hex') as string}88ac`
    s.scan!.addresses = [{ path: 'm/9/4', address, label: 'HandCash items', wallets: 'HandCash' }]
    s.scan!.holdings = [holding(address, 2)]
    vi.mocked(loadImportedSources).mockResolvedValue([s])
    const utxo = (n: number) => ({
      txid: op(n).slice(0, 64),
      vout: 0,
      satoshis: 1,
      script: lock,
      address,
      path: 'm/9/4',
      type: 'standard',
      status: 'available',
      height: 1,
    })
    vi.mocked(fetchHandCashUtxoSet).mockResolvedValue({ kind: 'fetched', utxos: [utxo(1), utxo(2)] })
    const asked: string[][] = []
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const outpoints = JSON.parse(String(init?.body)) as string[]
      asked.push(outpoints)
      return new Response(
        JSON.stringify(
          outpoints.map((outpoint) => ({
            outpoint,
            spend: '',
            origin: {
              outpoint,
              data: {
                map: { app: 'zoo', name: 'Fox' },
                insc: { file: { type: 'image/png' } },
                sigma: [{ algorithm: 'BSM', address: '1BHLmsoMt4J4oyKbpPu2PoBDiP8C5h2sQx', valid: true }],
              },
            },
          })),
        ),
      )
    })
    expect(await syncImportItems({ sourceId: 's1', fetchImpl })).toEqual({ complete: true, total: 2 })
    expect(asked).toEqual([[op(1), op(2)]])
    const shelves = await readImportShelves('s1')
    expect(shelves.map((sh) => [sh.key, sh.label, sh.count])).toEqual([
      ['signer:1BHLmsoMt4J4oyKbpPu2PoBDiP8C5h2sQx', 'zoo', 2],
    ])
    expect(shelves[0]!.faces[0]!.imageUrl).toBe(`https://ordinals.gorillapool.io/content/${op(1)}`)

    vi.mocked(fetchHandCashUtxoSet).mockResolvedValue({ kind: 'fetched', utxos: [utxo(2), utxo(3)] })
    const changes: ImportItemChange[] = []
    await syncImportItems({ sourceId: 's1', fetchImpl, onChange: (c) => changes.push(c) })
    expect(asked[1]).toEqual([op(3)])
    expect(changes[0]).toEqual({ added: 0, gone: [op(1)] })
    expect(await listed()).toEqual([op(2), op(3)])

    vi.mocked(fetchHandCashUtxoSet).mockResolvedValue({ kind: 'refused', reason: 'unavailable', detail: '503' })
    expect(await syncImportItems({ sourceId: 's1', fetchImpl })).toEqual({ complete: false, total: 2 })
  })

  it('refuses an unscanned source', async () => {
    vi.mocked(loadImportedSources).mockResolvedValue([{ ...source([]), scan: null }])
    await expect(syncImportItems({ sourceId: 's1' })).rejects.toThrow('Scan this wallet first')
  })
})

/** The chosen-items migrate answering each tip by outpoint. */
function migrateAnswers(resultOf: (outpoint: string) => SingleItemMigrate) {
  vi.mocked(migrateChosenPhraseItems).mockImplementation(async ({ items }) => {
    const results = new Map(items.map((item) => [item.outpoint, resultOf(item.outpoint)] as const))
    const moved = [...results.values()].filter((r) => r.kind === 'moved')
    return {
      results,
      stopped: [...results.values()].some((r) => r.kind === 'funds') ? 'funds' : null,
      transactions: moved.length > 0 ? 1 : 0,
    }
  })
}

const MOVED: SingleItemMigrate = { kind: 'moved', txid: 'f'.repeat(64) }

describe('importItems', () => {
  it('moves each key’s chosen items in one call, counts them out of the scan, and drops them from the list', async () => {
    vi.mocked(loadImportedSources).mockResolvedValue([source([holding('1a', 3), holding('1b', 2)])])
    await saveImportItems('s1', [stored(1, '1a'), stored(2, '1b'), stored(3, '1a'), stored(4, '1a'), stored(5, '1b')])
    migrateAnswers(() => MOVED)

    const run = await importItems({ sourceId: 's1', outpoints: [op(1), op(2), op(3), op(5)] })
    expect(run.stopped).toBeNull()
    expect(run.results.map((r) => [r.outpoint, r.result.kind])).toEqual([
      [op(1), 'moved'],
      [op(2), 'moved'],
      [op(3), 'moved'],
      [op(5), 'moved'],
    ])
    const calls = vi.mocked(migrateChosenPhraseItems).mock.calls.map(([a]) => a)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ candidate: { address: '1a', scheme: 'import' } })
    expect(calls[0]!.items).toEqual([
      { outpoint: op(1), origin: op(1), name: 'Item 1' },
      { outpoint: op(3), origin: op(3), name: 'Item 3' },
    ])
    expect(calls[1]!.items.map((i) => i.outpoint)).toEqual([op(2), op(5)])
    expect(updateImportedSource).toHaveBeenCalledTimes(1)
    expect(vi.mocked(updateImportedSource).mock.calls[0]![1].scan?.holdings.map((h) => h.itemCount)).toEqual([1, 0])
    expect(await listed()).toEqual([op(4)])
  })

  it('refuses an unlisted item, an address outside the scan, and a paused sweep’s address', async () => {
    vi.mocked(loadImportedSources).mockResolvedValue([source([holding('1a', 1)])])
    await saveImportItems('s1', [stored(1, '1a'), stored(2, '1z')])
    const first = await importItems({ sourceId: 's1', outpoints: [op(9), op(2)] })
    expect(first.results.map((r) => r.result)).toMatchObject([
      { kind: 'refused', reason: 'unlisted' },
      { kind: 'refused', reason: 'gone' },
    ])
    vi.mocked(peekPhraseItemMigrateCursor).mockReturnValue({ sourceAddress: '1a' } as never)
    const paused = await importItems({ sourceId: 's1', outpoints: [op(1)] })
    expect(paused.results[0]!.result).toMatchObject({ kind: 'refused', reason: 'pausedBatch' })
    expect(migrateChosenPhraseItems).not.toHaveBeenCalled()
  })

  it('keeps unmoved items and the scan, and stops later keys once BSV runs out', async () => {
    vi.mocked(loadImportedSources).mockResolvedValue([source([holding('1a', 2), holding('1b', 1)])])
    await saveImportItems('s1', [stored(1, '1a'), stored(2, '1a'), stored(3, '1b')])
    migrateAnswers((outpoint) => (outpoint === op(1) ? MOVED : { kind: 'funds', message: 'low' }))

    const run = await importItems({ sourceId: 's1', outpoints: [op(1), op(2), op(3)] })
    expect(run.stopped).toBe('funds')
    expect(run.results.map((r) => r.result.kind)).toEqual(['moved', 'funds', 'funds'])
    expect(migrateChosenPhraseItems).toHaveBeenCalledTimes(1)
    expect(vi.mocked(updateImportedSource).mock.calls[0]![1].scan?.holdings.map((h) => h.itemCount)).toEqual([1, 1])
    expect(await listed()).toEqual([op(2), op(3)])
  })
})
