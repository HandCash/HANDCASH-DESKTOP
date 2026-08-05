import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedInscription } from './oneSatImport'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
  },
}))

const resolved = (origin: string): ResolvedInscription => ({
  origin,
  name: 'Sword',
  traits: [{ name: 'rarity', value: 'rare' }],
  extras: [],
})

describe('inscriptionCache', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('returns nothing for an outpoint it has never seen', async () => {
    const cache = await import('./inscriptionCache')

    expect(cache.getResolvedInscription('aa.0')).toBeNull()
    expect(cache.shouldResolveInscription('aa.0')).toBe(true)
  })

  it('never re-resolves an outpoint once resolved — inscriptions are immutable', async () => {
    const cache = await import('./inscriptionCache')
    cache.rememberResolvedInscription('aa.0', resolved('bb_1'))

    expect(cache.getResolvedInscription('aa.0')?.origin).toBe('bb_1')
    expect(cache.shouldResolveInscription('aa.0')).toBe(false)
  })

  it('survives a reload, so reopening the page costs no indexer walks', async () => {
    const cache = await import('./inscriptionCache')
    cache.rememberResolvedInscription('aa.0', resolved('bb_1'))

    vi.resetModules()
    const reloaded = await import('./inscriptionCache')

    expect(reloaded.getResolvedInscription('aa.0')?.origin).toBe('bb_1')
    expect(reloaded.getResolvedInscription('aa.0')?.traits).toEqual([
      { name: 'rarity', value: 'rare' },
    ])
    expect(reloaded.shouldResolveInscription('aa.0')).toBe(false)
  })

  it('backs off after a miss, then retries once the window passes', async () => {
    const cache = await import('./inscriptionCache')
    const at = Date.now()
    cache.rememberUnresolved('aa.0', at)

    expect(cache.shouldResolveInscription('aa.0', at + 1)).toBe(false)
    expect(cache.shouldResolveInscription('aa.0', at + cache.RESOLVE_RETRY_MS - 1)).toBe(false)
    expect(cache.shouldResolveInscription('aa.0', at + cache.RESOLVE_RETRY_MS)).toBe(true)
  })

  it('clears the back-off when the outpoint finally resolves', async () => {
    const cache = await import('./inscriptionCache')
    const at = Date.now()
    cache.rememberUnresolved('aa.0', at)
    cache.rememberResolvedInscription('aa.0', resolved('bb_1'))

    expect(cache.shouldResolveInscription('aa.0', at + 1)).toBe(false)
    expect(cache.getResolvedInscription('aa.0')).not.toBeNull()
  })

  it('lists normally when the stored blob is corrupt', async () => {
    store.set('handcash.inscriptionResolution.v1', '{not json')
    const cache = await import('./inscriptionCache')

    expect(cache.getResolvedInscription('aa.0')).toBeNull()
    expect(cache.shouldResolveInscription('aa.0')).toBe(true)
  })
})
