import { PrivateKey } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../appLog', () => ({ appendAppLog: vi.fn(), setStallContextProvider: vi.fn() }))
vi.mock('../yieldToUi', () => ({ yieldToUi: async () => undefined }))
vi.mock('../walletRuntime', () => ({ getWalletRuntime: () => null }))
vi.mock('../paymentPolicy', () => ({ assertOnlineForPayment: () => undefined }))
vi.mock('./store', () => ({ loadImportedSources: vi.fn(), updateImportedSource: vi.fn() }))
vi.mock('./holdings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./holdings')>()),
  inspectHoldings: vi.fn(),
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
import { hintedScan } from './scan'

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
