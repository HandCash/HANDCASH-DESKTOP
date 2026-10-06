import { PrivateKey } from '@bsv/sdk'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../appLog', () => ({ appendAppLog: vi.fn() }))
vi.mock('../yieldToUi', () => ({ yieldToUi: async () => undefined, uiBudgetExpired: () => false }))

import { discoverAddresses, locateAddress, uncompressedAddress, wocHistoryLookup } from './discovery'
import type { KeyDeriver } from './importSource'
import type { PathTemplate } from './pathCatalog'

/** A deterministic key per path, so tests can name which addresses are "used". */
function fakeDeriver(templates: PathTemplate[], fixed: KeyDeriver['fixed'] = []): KeyDeriver {
  const cache = new Map<string, PrivateKey>()
  return {
    templates,
    fixed,
    identity: null,
    privateKeyAt: (path) => {
      let key = cache.get(path)
      if (!key) {
        key = PrivateKey.fromString(
          Array.from(path).reduce((h, c) => (h * 31n + BigInt(c.charCodeAt(0))) % (1n << 200n), 7n).toString(16),
          16,
        )
        cache.set(path, key)
      }
      return key
    },
  }
}

const addressAt = (deriver: KeyDeriver, path: string) => deriver.privateKeyAt(path).toPublicKey().toAddress()

describe('discoverAddresses', () => {
  const template: PathTemplate = { id: 't', label: 'Test', wallets: 'Test', pattern: 'm/{i}', gap: 5 }

  it('extends the walk past each hit by the gap', async () => {
    const deriver = fakeDeriver([template])
    const used = new Set([addressAt(deriver, 'm/0'), addressAt(deriver, 'm/4'), addressAt(deriver, 'm/9')])
    const history = vi.fn(async (addresses: string[]) => new Set(addresses.filter((a) => used.has(a))))
    const result = await discoverAddresses({ deriver, history })
    expect(result.addresses.map((a) => a.path)).toEqual(['m/0', 'm/4', 'm/9'])
    // Highest hit 9 + gap 5 → indices 0…14 checked, nothing more.
    expect(result.checked).toBe(15)
    expect(result.complete).toBe(true)
  })

  it('treats a failed window as unknown, never as a gap', async () => {
    const deriver = fakeDeriver([template])
    const history = vi.fn(async () => {
      throw new Error('429')
    })
    const result = await discoverAddresses({ deriver, history })
    expect(result.complete).toBe(false)
    expect(result.failedLookups).toBeGreaterThan(0)
    expect(result.addresses).toEqual([])
  })

  it('asks the 1Sat index on an items root, where minted items hide from history', async () => {
    const itemsTemplate: PathTemplate = { ...template, itemsRoot: true }
    const deriver = fakeDeriver([itemsTemplate])
    const minted = addressAt(deriver, 'm/2')
    const result = await discoverAddresses({
      deriver,
      history: async () => new Set(),
      items: async (address) => address === minted,
    })
    expect(result.addresses.map((a) => a.path)).toEqual(['m/2'])
  })

  it('checks both forms of a pinned WIF and marks the uncompressed one', async () => {
    const key = PrivateKey.fromRandom()
    const deriver = fakeDeriver([], [{ path: 'wif:0', label: 'Private key', key }])
    const legacy = uncompressedAddress(key)
    const result = await discoverAddresses({
      deriver,
      history: async (addresses) => new Set(addresses.filter((a) => a === legacy)),
    })
    expect(result.addresses).toEqual([
      expect.objectContaining({ path: 'wif:0', address: legacy, uncompressed: true }),
    ])
  })

  it('stops when asked and reports incomplete', async () => {
    const deriver = fakeDeriver([template])
    const result = await discoverAddresses({
      deriver,
      history: async (a) => new Set(a),
      shouldStop: () => true,
    })
    expect(result.complete).toBe(false)
  })

  it('locates an address by walking the templates', async () => {
    const deriver = fakeDeriver([template])
    const hit = await locateAddress({ deriver, address: addressAt(deriver, 'm/37'), depth: 100 })
    expect(hit?.path).toBe('m/37')
    expect(await locateAddress({ deriver, address: '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH', depth: 10 })).toBeNull()
  })
})

describe('wocHistoryLookup', () => {
  it('reads used addresses from the bulk history answer', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify([
          { address: 'a', history: [{ tx_hash: 'x' }] },
          { address: 'b', history: [] },
        ]),
        { status: 200 },
      ),
    )
    const used = await wocHistoryLookup('main', fetchImpl)(['a', 'b'])
    expect([...used]).toEqual(['a'])
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.whatsonchain.com/v1/bsv/main/addresses/history',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ addresses: ['a', 'b'] }) }),
    )
  })

  it('does not retry a client error', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 400 }))
    await expect(wocHistoryLookup('main', fetchImpl)(['a'])).rejects.toThrow('WhatsOnChain 400')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
