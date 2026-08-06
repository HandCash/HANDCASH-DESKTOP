import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
  },
}))

describe('provenCache', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('unknown outpoints are not proven', async () => {
    const cache = await import('./provenCache')
    expect(cache.isItemProven('aa.0')).toBe(false)
    expect(cache.hasProvenVerdict('aa.0')).toBe(false)
  })

  it('remembers a true verdict across normalize forms', async () => {
    const cache = await import('./provenCache')
    cache.rememberProvenVerdict('AA_0', true)
    expect(cache.isItemProven('aa.0')).toBe(true)
    expect(cache.hasProvenVerdict('aa.0')).toBe(true)
  })

  it('remembers a false verdict so we do not re-verify forever', async () => {
    const cache = await import('./provenCache')
    cache.rememberProvenVerdict('bb.1', false)
    expect(cache.isItemProven('bb.1')).toBe(false)
    expect(cache.hasProvenVerdict('bb.1')).toBe(true)
  })
})
