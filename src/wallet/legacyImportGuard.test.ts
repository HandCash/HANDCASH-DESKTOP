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

  it('never reclaims a marked outpoint — an unspent scan row is indexer lag', async () => {
    const guard = await import('./legacyImportGuard')
    guard.markLegacyImported(['aa.0'])
    guard.resetLegacyImportGraceForTests()

    // Once marked, it stays marked. Re-sweeping on a lagging scan would
    // double-spend our own funding transaction.
    expect(guard.isLegacyOutpointKnown('aa.0')).toBe(true)
    expect(guard.filterNewLegacyOutpoints(['aa.0'])).toEqual([])
  })

  it('keeps the grace window across a reload', async () => {
    const guard = await import('./legacyImportGuard')
    guard.markLegacyImported(['aa.0'])
    vi.resetModules()

    const guard2 = await import('./legacyImportGuard')
    // A fresh process has no in-memory timestamp — the durable record supplies it.
    expect(guard2.isLegacyImportGraceActive()).toBe(true)
  })

  it('stores the sweep txid for log correlation', async () => {
    const guard = await import('./legacyImportGuard')
    guard.markLegacyImported([{ outpoint: 'aa.0', txid: 'A'.repeat(64) }])
    expect(guard.legacySweepRecord('aa.0')?.txid).toBe('a'.repeat(64))
  })

  it('migrates v1 marks without opening a grace window', async () => {
    store.set(
      'handcash.brc100.importedLegacyOutpoints.v1',
      JSON.stringify(['aa.0', 'bb.1']),
    )
    const guard = await import('./legacyImportGuard')
    expect(guard.isLegacyOutpointKnown('aa.0')).toBe(true)
    expect(guard.isLegacyImportGraceActive()).toBe(false)
  })
})
