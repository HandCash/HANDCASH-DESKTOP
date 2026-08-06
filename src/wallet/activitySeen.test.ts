import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

describe('activitySeen', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('treats a first-ever feed as already seen, so a restored history never flashes', async () => {
    const seen = await import('./activitySeen')

    expect(seen.activitySeenReady()).toBe(false)
    seen.markActivitySeen(['b', 'a'])

    expect(seen.activitySeenReady()).toBe(true)
    expect(seen.hasSeenActivity('b')).toBe(true)
    expect(seen.hasSeenActivity('a')).toBe(true)
  })

  it('reports an arrival the user has not been shown yet', async () => {
    const seen = await import('./activitySeen')
    seen.markActivitySeen(['a'])

    expect(seen.hasSeenActivity('new')).toBe(false)
    seen.markActivitySeen(['new', 'a'])
    expect(seen.hasSeenActivity('new')).toBe(true)
  })

  it('survives a reload, so reopening the feed announces nothing', async () => {
    const first = await import('./activitySeen')
    first.markActivitySeen(['top', 'older'])

    vi.resetModules()
    const reloaded = await import('./activitySeen')

    expect(reloaded.activitySeenReady()).toBe(true)
    expect(reloaded.hasSeenActivity('top')).toBe(true)
  })

  it('keeps the newest ids when the record is full', async () => {
    const seen = await import('./activitySeen')
    const ids = Array.from({ length: 600 }, (_, i) => `id-${i}`)
    // Newest first, matching feed order.
    seen.markActivitySeen(ids)

    expect(seen.hasSeenActivity('id-0')).toBe(true)
    expect(seen.hasSeenActivity('id-499')).toBe(true)
    expect(seen.hasSeenActivity('id-599')).toBe(false)
  })

  it('seeds quietly when the stored record is corrupt', async () => {
    store.set('handcash.activitySeen.v1', '{not json')
    const seen = await import('./activitySeen')

    expect(seen.activitySeenReady()).toBe(false)
    expect(seen.hasSeenActivity('a')).toBe(false)
  })
})
