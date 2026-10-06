import { PrivateKey } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../appLog', () => ({ appendAppLog: vi.fn(), setStallContextProvider: vi.fn() }))
vi.mock('../yieldToUi', () => ({ yieldToUi: async () => undefined, uiBudgetExpired: () => false }))
vi.mock('../walletRuntime', () => ({ getWalletRuntime: () => null }))
vi.mock('../paymentPolicy', () => ({ assertOnlineForPayment: () => undefined }))
vi.mock('./store', () => ({ loadImportedSources: vi.fn(), updateImportedSource: vi.fn() }))
vi.mock('./holdings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./holdings')>()),
  inspectHoldings: vi.fn(),
}))
vi.mock('./handcashUtxoSet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./handcashUtxoSet')>()),
  fetchHandCashUtxoSet: vi.fn(),
  readUnspentCash: vi.fn(),
  readUnspentOutpoints: vi.fn(),
}))
vi.mock('./items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./items')>()),
  rememberImportItems: vi.fn(),
}))
vi.mock('./recoveryHints', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./recoveryHints')>()),
  createHistoryReader: vi.fn(),
  readItemOwners: vi.fn(),
}))

import { emptyHoldings, inspectHoldings, type AddressHoldings } from './holdings'
import type { DiscoveredAddress } from './discovery'
import type { KeyDeriver } from './importSource'
import { createHistoryReader, readItemOwners, type HandCashRecoveryHints, type HintedAddresses } from './recoveryHints'
import { fetchHandCashUtxoSet, readUnspentCash, readUnspentOutpoints, type HandCashUtxo } from './handcashUtxoSet'
import { rememberImportItems } from './items'
import { hintedScan, utxoSetScan } from './scan'
import { P2PKH } from '@bsv/sdk'

const keys = new Map<string, PrivateKey>()
const deriver: KeyDeriver = {
  templates: [{ id: 'hc', label: 'HandCash', wallets: 'HandCash', pattern: 'm/{i}', gap: 5 }],
  fixed: [],
  identity: null,
  privateKeyAt: (path) => {
    let key = keys.get(path)
    if (!key) keys.set(path, (key = PrivateKey.fromRandom()))
    return key
  },
}
const at = (path: string) => deriver.privateKeyAt(path).toPublicKey().toAddress()

function hints(over: Partial<HandCashRecoveryHints> = {}): HandCashRecoveryHints {
  return {
    handle: 'alice',
    txids: Array.from({ length: 3_000 }, (_, i) => i.toString(16).padStart(64, '0')),
    origins: [],
    historyComplete: true,
    satoshis: 10_000,
    itemCount: 0,
    receivedAt: 0,
    ...over,
  }
}

/** History whose newest `n` transactions pay the addresses listed for that window. */
function historyPaying(windows: Array<[number, string[]]>) {
  const asked: number[] = []
  let position = 0
  vi.mocked(createHistoryReader).mockImplementation(({ txids }) => ({
    get position() {
      return position
    },
    async readUntil(limit) {
      asked.push(limit)
      position = Math.min(limit, txids.length)
    },
    snapshot(): HintedAddresses {
      const paid = new Set(windows.filter(([upTo]) => upTo <= position).flatMap(([, a]) => a))
      return { addresses: paid, mayHold: new Set(paid), read: position, unknown: 0, failed: 0, stopped: false }
    },
  }))
  return asked
}

/** The chain: what each address holds, read only when the scan asks. */
function chainHolds(by: Record<string, Partial<AddressHoldings>>) {
  vi.mocked(inspectHoldings).mockImplementation(async ({ addresses, mayHold, cache }) =>
    addresses.map((a: DiscoveredAddress) => {
      if (mayHold && !mayHold.has(a.address)) return emptyHoldings(a)
      const read = cache?.get(a.address) ?? { ...emptyHoldings(a), ...by[a.address] }
      cache?.set(a.address, read)
      return read
    }),
  )
}

describe('hintedScan', () => {
  beforeEach(() => {
    vi.mocked(createHistoryReader).mockReset()
    vi.mocked(readItemOwners).mockReset()
    vi.mocked(inspectHoldings).mockReset()
  })

  it('stops widening history once the chain covers the claim', async () => {
    const asked = historyPaying([
      [500, [at('m/0')]],
      [2_500, [at('m/3')]],
    ])
    chainHolds({ [at('m/0')]: { cashSats: 4_000 }, [at('m/3')]: { cashSats: 6_000 } })
    const scan = await hintedScan(deriver, 'main', hints(), { sourceId: 's' })
    expect(asked).toEqual([500, 2_500])
    expect(scan).toMatchObject({ via: 'handcash-history' })
    expect(scan?.addresses.map((a) => a.path)).toEqual(['m/0', 'm/3'])
  })

  it('hands the full walk its reads when even the whole history falls short', async () => {
    const asked = historyPaying([[500, [at('m/0')]]])
    chainHolds({ [at('m/0')]: { cashSats: 4_000 } })
    const cache = new Map<string, AddressHoldings>()
    expect(await hintedScan(deriver, 'main', hints(), { sourceId: 's' }, cache)).toBeNull()
    expect(asked).toEqual([500, 2_500, 3_000])
    expect([...cache.keys()]).toEqual([at('m/0')])
  })

  it('finds items by their owners without reading history first', async () => {
    const asked = historyPaying([])
    vi.mocked(readItemOwners).mockResolvedValue({
      owners: new Set([at('m/1')]),
      unspent: 2,
      located: 2,
      missing: 0,
      failed: 0,
      stopped: false,
    })
    chainHolds({ [at('m/1')]: { itemCount: 2 } })
    const scan = await hintedScan(
      deriver,
      'main',
      hints({ txids: [], origins: ['a_0', 'b_0'], satoshis: 0, itemCount: 2 }),
      { sourceId: 's' },
    )
    expect(asked).toEqual([0])
    expect(scan).toMatchObject({ via: 'handcash-history' })
    expect(scan?.holdings.find((h) => h.address === at('m/1'))?.itemCount).toBe(2)
  })

  it('never shortcuts an empty claim', async () => {
    const asked = historyPaying([])
    expect(await hintedScan(deriver, 'main', hints({ satoshis: 0, itemCount: 0 }), { sourceId: 's' })).toBeNull()
    expect(asked).toEqual([])
  })
})

describe('utxoSetScan', () => {
  beforeEach(() => {
    vi.mocked(fetchHandCashUtxoSet).mockReset()
    vi.mocked(readUnspentCash).mockReset()
    vi.mocked(readUnspentOutpoints).mockReset()
    vi.mocked(inspectHoldings).mockReset()
    vi.mocked(readUnspentCash).mockResolvedValue({ unspent: new Set(), unknown: new Set(), stopped: false })
  })

  const row = (n: number, path: string, satoshis: number, type = 'standard'): HandCashUtxo => ({
    txid: n.toString(16).padStart(64, '0'),
    vout: 0,
    satoshis,
    script: new P2PKH().lock(at(path)).toHex(),
    address: at(path),
    path,
    type,
    status: 'available',
    height: 1,
  })
  const op = (n: number) => `${n.toString(16).padStart(64, '0')}_0`

  it('checks cash and items by outpoint and reads in full only what it cannot place', async () => {
    vi.mocked(fetchHandCashUtxoSet).mockResolvedValue({
      kind: 'fetched',
      utxos: [
        row(1, 'm/0/4', 9_000),
        row(5, 'm/0/4', 10),
        row(6, 'm/0/4', 7_000),
        row(2, 'm/9/1', 1),
        row(3, 'm/9/1', 1),
        row(4, 'm/9/2', 1),
        row(7, 'm/0/5', 4_000),
        row(8, 'm/7/0', 1, 'instrument'),
      ],
    })
    vi.mocked(readUnspentCash).mockResolvedValue({
      unspent: new Set([op(1), op(5)]),
      unknown: new Set([op(7)]),
      stopped: false,
    })
    vi.mocked(readUnspentOutpoints).mockImplementation(async ({ outpoints }) => ({
      unspent: new Set(outpoints.filter((o) => o !== op(3))),
      facts: new Map([[op(2), { origin: op(2), media: op(2), name: 'Two', mimeType: 'image/png' }]]),
      failed: 0,
      stopped: false,
    }))
    chainHolds({ [at('m/0/5')]: { cashSats: 4_000, cashCount: 1 }, [at('m/7/0')]: { tokens: [] } })

    const scan = await utxoSetScan(deriver, 'main', { sourceId: 's' })
    expect(scan).toMatchObject({ via: 'handcash-utxo-set', complete: true, checked: 5 })
    expect(scan?.holdings.map((h) => [h.path, h.cashSats, h.cashCount, h.dustCount, h.itemCount])).toEqual([
      ['m/0/4', 9_000, 1, 1, 0],
      ['m/9/1', 0, 0, 0, 1],
      ['m/9/2', 0, 0, 0, 1],
      ['m/0/5', 4_000, 1, 0, 0],
      ['m/7/0', 0, 0, 0, 0],
    ])
    expect(vi.mocked(readUnspentCash).mock.calls[0][0].outputs.map((o) => o.outpoint)).toEqual([op(1), op(5), op(6), op(7)])
    expect(vi.mocked(inspectHoldings).mock.calls[0][0].addresses.map((a) => a.path)).toEqual(['m/0/5', 'm/7/0'])
    expect(vi.mocked(rememberImportItems)).toHaveBeenCalledWith('s', scan?.at, {
      items: [
        { outpoint: op(2), address: at('m/9/1'), origin: op(2), media: op(2), name: 'Two', mimeType: 'image/png', imageUrl: null },
        { outpoint: op(4), address: at('m/9/2'), origin: null, media: null, name: null, mimeType: null, imageUrl: null },
      ],
      complete: true,
    })
  })

  it('falls back when the set cannot be had or no row derives', async () => {
    vi.mocked(fetchHandCashUtxoSet).mockResolvedValueOnce({ kind: 'refused', reason: 'unknown-keys', detail: 'unknown-keys' })
    expect(await utxoSetScan(deriver, 'main', { sourceId: 's' })).toBeNull()
    vi.mocked(fetchHandCashUtxoSet).mockResolvedValueOnce({
      kind: 'fetched',
      utxos: [{ ...row(1, 'm/0/4', 9_000), address: PrivateKey.fromRandom().toAddress() }],
    })
    expect(await utxoSetScan(deriver, 'main', { sourceId: 's' })).toBeNull()
    expect(inspectHoldings).not.toHaveBeenCalled()
  })

  it('takes an empty set as an empty account', async () => {
    vi.mocked(fetchHandCashUtxoSet).mockResolvedValue({ kind: 'fetched', utxos: [] })
    vi.mocked(readUnspentOutpoints).mockResolvedValue({ unspent: new Set(), facts: new Map(), failed: 0, stopped: false })
    chainHolds({})
    expect(await utxoSetScan(deriver, 'main', { sourceId: 's' })).toMatchObject({
      via: 'handcash-utxo-set',
      complete: true,
      addresses: [],
      holdings: [],
    })
  })

  it('marks the scan incomplete when an item check failed', async () => {
    vi.mocked(fetchHandCashUtxoSet).mockResolvedValue({ kind: 'fetched', utxos: [row(2, 'm/9/1', 1)] })
    vi.mocked(readUnspentOutpoints).mockResolvedValue({ unspent: new Set(), facts: new Map(), failed: 1, stopped: false })
    chainHolds({})
    expect(await utxoSetScan(deriver, 'main', { sourceId: 's' })).toMatchObject({ complete: false })
  })
})
