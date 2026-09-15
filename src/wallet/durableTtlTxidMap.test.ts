import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDurableTtlTxidMap } from './durableTtlTxidMap'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (k: string) => store.get(k) ?? null,
  durableSetItem: (k: string, v: string) => {
    store.set(k, v)
  },
}))

const TX = 'aa'.repeat(32)

describe('createDurableTtlTxidMap', () => {
  beforeEach(() => {
    store.clear()
  })

  it('remembers, has, and forgets a txid', () => {
    const map = createDurableTtlTxidMap({
      key: 'test.ttl',
      max: 10,
      ttlMs: 60_000,
    })
    expect(map.has(TX)).toBe(false)
    map.remember(TX)
    expect(map.has(TX)).toBe(true)
    map.forget(TX)
    expect(map.has(TX)).toBe(false)
  })

  it('accepts legacy number timestamps', () => {
    store.set('test.legacy', JSON.stringify({ [TX]: Date.now() }))
    const map = createDurableTtlTxidMap({
      key: 'test.legacy',
      max: 10,
      ttlMs: 60_000,
    })
    expect(map.has(TX)).toBe(true)
  })

  it('ignores non-txid keys', () => {
    store.set('test.junk', JSON.stringify({ nope: { at: Date.now() } }))
    const map = createDurableTtlTxidMap({
      key: 'test.junk',
      max: 10,
      ttlMs: 60_000,
    })
    expect(map.has('nope')).toBe(false)
  })
})
