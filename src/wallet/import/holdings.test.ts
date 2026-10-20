import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../appLog', () => ({ appendAppLog: vi.fn(), setStallContextProvider: vi.fn() }))
vi.mock('../phraseSweep', () => ({ countOrdinalsAtLeast: vi.fn(), scanAddressAny: vi.fn() }))
vi.mock('../yieldToUi', () => ({ yieldToUi: async () => undefined, uiBudgetExpired: () => false }))

import { countOrdinalsAtLeast, scanAddressAny } from '../phraseSweep'
import type { DiscoveredAddress } from './discovery'
import {
  inspectHoldings,
  totalHoldings,
  type AddressHoldings,
} from './holdings'
import { planSweep } from './sweep'

const base: AddressHoldings = {
  address: '1a',
  path: 'm/0/0',
  label: 'HandCash',
  wallets: 'HandCash',
  uncompressed: false,
  cashSats: 0,
  cashCount: 0,
  dustCount: 0,
  itemCount: 0,
  itemCountCapped: false,
  error: null,
}

describe('totalHoldings', () => {
  it('sums compatible assets and names what stays', () => {
    const totals = totalHoldings([
      { ...base, cashSats: 5_000, cashCount: 2, itemCount: 3, dustCount: 1 },
      { ...base, address: '1b', cashSats: 1_000, cashCount: 1 },
      { ...base, address: '1c', uncompressed: true, cashSats: 9_999, cashCount: 1 },
      { ...base, address: '1d', error: 'timeout' },
    ])
    expect(totals.cashSats).toBe(6_000)
    expect(totals.cashCount).toBe(3)
    expect(totals.itemCount).toBe(3)
    expect(totals.held).toEqual({ dust: 1, uncompressed: 1 })
    expect(totals.partial).toBe(1)
  })

  it('plans a sweep that skips uncompressed keys entirely', () => {
    const plan = planSweep({
      scan: {
        at: 0,
        complete: true,
        checked: 1,
        addresses: [],
        holdings: [
          { ...base, cashCount: 1, cashSats: 10 },
          { ...base, address: '1u', uncompressed: true, cashCount: 4, itemCount: 2 },
          { ...base, address: '1t', itemCount: 1 },
        ],
      },
    })
    expect(plan.cash.map((h) => h.address)).toEqual(['1a'])
    expect(plan.items.map((h) => h.address)).toEqual(['1t'])
  })
})

describe('inspectHoldings', () => {
  const at = (address: string): DiscoveredAddress =>
    ({ address, path: `m/${address}`, label: 'HandCash', wallets: 'HandCash' }) as DiscoveredAddress

  afterEach(() => {
    vi.mocked(scanAddressAny).mockReset()
    vi.mocked(countOrdinalsAtLeast).mockReset()
    vi.unstubAllGlobals()
  })

  function chainHolds(items: Record<string, number>) {
    vi.mocked(scanAddressAny).mockResolvedValue({ utxos: [] } as unknown as Awaited<ReturnType<typeof scanAddressAny>>)
    vi.mocked(countOrdinalsAtLeast).mockImplementation(async (address) => ({ count: items[address] ?? 0, capped: false }))
  }

  it('reads only addresses that may still hold something, and reuses reads within a scan', async () => {
    chainHolds({ '1a': 2, '1c': 1 })
    const cache = new Map<string, AddressHoldings>()
    const first = await inspectHoldings({
      addresses: [at('1a'), at('1b')],
      chain: 'main',
      mayHold: new Set(['1a']),
      cache,
    })
    expect(first.map((h) => [h.address, h.itemCount])).toEqual([
      ['1a', 2],
      ['1b', 0],
    ])
    expect(scanAddressAny).toHaveBeenCalledTimes(1)

    const second = await inspectHoldings({
      addresses: [at('1a'), at('1b'), at('1c')],
      chain: 'main',
      mayHold: new Set(['1a', '1c']),
      cache,
    })
    expect(second.map((h) => [h.address, h.itemCount])).toEqual([
      ['1a', 2],
      ['1b', 0],
      ['1c', 1],
    ])
    expect(vi.mocked(scanAddressAny).mock.calls.map(([address]) => address)).toEqual(['1a', '1c'])
  })

  it('does not cache a read that failed, so a wider window asks again', async () => {
    chainHolds({})
    vi.mocked(scanAddressAny).mockRejectedValueOnce(new Error('timeout'))
    const cache = new Map<string, AddressHoldings>()
    const [failed] = await inspectHoldings({ addresses: [at('1a')], chain: 'main', cache })
    expect(failed.error).toBe('timeout')
    expect(cache.size).toBe(0)
    await inspectHoldings({ addresses: [at('1a')], chain: 'main', cache })
    expect(scanAddressAny).toHaveBeenCalledTimes(2)
    expect(cache.has('1a')).toBe(true)
  })
})
