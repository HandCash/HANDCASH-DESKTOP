import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
  },
}))

describe('oneSatImportGuard', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('filters already imported and in-flight outpoints', async () => {
    const guard = await import('./oneSatImportGuard')
    const first = guard.beginOneSatImport(['aa.0', 'bb.1', 'aa.0'])
    expect(first).toEqual(['aa.0', 'bb.1'])

    const second = guard.beginOneSatImport(['aa.0', 'cc.2'])
    expect(second).toEqual(['cc.2'])

    guard.markOneSatImported(['aa.0'])
    guard.releaseOneSatImport(['bb.1'])

    const third = guard.filterNewOneSatOutpoints(['aa.0', 'bb.1', 'cc.2', 'dd.3'])
    expect(third).toEqual(['bb.1', 'dd.3'])
  })

  it('persists imported outpoints across module reloads', async () => {
    const guard = await import('./oneSatImportGuard')
    guard.markOneSatImported(['deadbeef.0'])
    vi.resetModules()
    const guard2 = await import('./oneSatImportGuard')
    expect(guard2.isOneSatOutpointKnown('deadbeef.0')).toBe(true)
    expect(guard2.filterNewOneSatOutpoints(['deadbeef.0', 'cafe.1'])).toEqual(['cafe.1'])
  })

  it('backs off failed imports so polls do not re-fetch BEEF immediately', async () => {
    const guard = await import('./oneSatImportGuard')
    guard.markOneSatImportFailed(['latch.0'])
    expect(guard.filterNewOneSatOutpoints(['latch.0', 'other.1'])).toEqual(['other.1'])
    expect(guard.beginOneSatImport(['latch.0'])).toEqual([])
  })

  it('normalizes underscore outpoints to dotted form', async () => {
    const guard = await import('./oneSatImportGuard')
    guard.markOneSatImported(['abcd_0'])
    expect(guard.isOneSatOutpointKnown('abcd.0')).toBe(true)
  })
})
