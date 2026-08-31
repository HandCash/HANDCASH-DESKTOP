import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  isIndexBasket,
  parseIndexPermissionBasket,
  prepareIndexBasketArgs,
  indexAccessGranted,
  mergeIndexGrant,
} from './indexAccess'
import { INDEX_STORAGE_BASKET } from './indexExpansionTypes'

describe('indexAccess', () => {
  it('parses p index read pack id', () => {
    expect(parseIndexPermissionBasket('p index read handcash.market.catalog')).toEqual({
      op: 'read',
      packId: 'handcash.market.catalog',
    })
  })

  it('rewrites read basket to storage index with pack tag', () => {
    const prepared = prepareIndexBasketArgs({
      basket: 'p index read myapp.feed',
      limit: 10,
    })
    expect(prepared.error).toBeUndefined()
    expect(prepared.indexReadRequest?.packId).toBe('myapp.feed')
    const body = prepared.args as { basket: string; tags: string[] }
    expect(body.basket).toBe(INDEX_STORAGE_BASKET)
    expect(body.tags).toContain('pack:myapp.feed')
  })

  it('detects index baskets', () => {
    expect(isIndexBasket('index')).toBe(true)
    expect(isIndexBasket('p index read x')).toBe(true)
    expect(isIndexBasket('1sat')).toBe(false)
  })

  it('merges durable pack grants', () => {
    const access = mergeIndexGrant({ packs: [] }, 'a.b')
    expect(indexAccessGranted(access, 'a.b')).toBe(true)
    expect(indexAccessGranted(access, 'other')).toBe(false)
  })
})

describe('indexExpansionManifest', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      store: {} as Record<string, string>,
      getItem(k: string) {
        return this.store[k] ?? null
      },
      setItem(k: string, v: string) {
        this.store[k] = v
      },
      removeItem(k: string) {
        delete this.store[k]
      },
    })
  })

  it('validates reference market manifest', async () => {
    const { validateIndexExpansionManifest } = await import('./indexExpansionManifest')
    const { HANDCASH_MARKET_CATALOG_MANIFEST } = await import('./indexExpansionTypes')
    const manifest = validateIndexExpansionManifest(HANDCASH_MARKET_CATALOG_MANIFEST)
    expect(manifest.packId).toBe('handcash.market.catalog')
    expect(manifest.scope.query).toEqual({ mode: 'active', limit: 500 })
    expect(manifest.discovery?.mode).toBe('auto')
  })
})

describe('indexExpansion store', () => {
  beforeEach(async () => {
    vi.stubGlobal('localStorage', {
      store: {} as Record<string, string>,
      getItem(k: string) {
        return this.store[k] ?? null
      },
      setItem(k: string, v: string) {
        this.store[k] = v
      },
      removeItem(k: string) {
        delete this.store[k]
      },
    })
    const { clearIndexExpansionStoreForTests } = await import('./indexExpansionStore')
    clearIndexExpansionStoreForTests()
  })

  it('lists and queries cached entries', async () => {
    const store = await import('./indexExpansionStore')
    const row = store.buildIndexEntryRecord({
      packId: 'demo',
      entryKey: 'listing:abc_0',
      overlayOutpoint: 'abc123_0',
      ci: { packId: 'demo', entryKey: 'listing:abc_0', name: 'Demo' },
    })
    store.replaceStoredIndexEntries('demo', [row])
    const page = store.queryStoredIndexEntries({ packId: 'demo', limit: 10 })
    expect(page.totalOutputs).toBe(1)
    expect(page.outputs[0]?.basket).toBe('index')
  })
})
