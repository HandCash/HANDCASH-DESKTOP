import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
  },
}))

describe('legacyImportGuard', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('filters already imported and in-flight outpoints', async () => {
    const guard = await import('./legacyImportGuard')
    const first = guard.beginLegacyImport(['aa.0', 'bb.1', 'aa.0'])
    expect(first).toEqual(['aa.0', 'bb.1'])

    const second = guard.beginLegacyImport(['aa.0', 'cc.2'])
    expect(second).toEqual(['cc.2'])

    guard.markLegacyImported(['aa.0'])
    guard.releaseLegacyImport(['bb.1'])

    const third = guard.filterNewLegacyOutpoints(['aa.0', 'bb.1', 'cc.2', 'dd.3'])
    // aa marked imported; cc still in-flight; bb released and not marked → allowed
    expect(third).toEqual(['bb.1', 'dd.3'])
  })

  it('persists imported outpoints across module reloads', async () => {
    const guard = await import('./legacyImportGuard')
    guard.markLegacyImported(['deadbeef.0'])
    vi.resetModules()
    const guard2 = await import('./legacyImportGuard')
    expect(guard2.isLegacyOutpointKnown('deadbeef.0')).toBe(true)
    expect(guard2.filterNewLegacyOutpoints(['deadbeef.0', 'cafe.1'])).toEqual(['cafe.1'])
  })
})
