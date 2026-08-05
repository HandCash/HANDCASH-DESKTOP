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

  it('reclaims still-unspent outpoints whose sweep is older than the retry window', async () => {
    const guard = await import('./legacyImportGuard')
    const stale = Date.now() - guard.SWEEP_RETRY_MS - 1
    vi.setSystemTime(stale)
    guard.markLegacyImported(['aa.0', 'bb.1'])
    vi.useRealTimers()
    guard.resetLegacyImportGraceForTests()

    const reclaimed = guard.reclaimStillUnspentLegacyOutpoints([
      { outpoint: 'aa.0', satoshis: 50_000 },
      { outpoint: 'bb.1', satoshis: 1 },
      { outpoint: 'cc.2', satoshis: 10_000 },
    ])
    expect(reclaimed).toEqual(['aa.0'])
    expect(guard.filterNewLegacyOutpoints(['aa.0', 'bb.1', 'cc.2'])).toEqual(['aa.0', 'cc.2'])
  })

  it('does not reclaim a fresh sweep — an unspent scan row is indexer lag', async () => {
    const guard = await import('./legacyImportGuard')
    guard.markLegacyImported(['aa.0'])
    guard.resetLegacyImportGraceForTests()

    const reclaimed = guard.reclaimStillUnspentLegacyOutpoints([
      { outpoint: 'aa.0', satoshis: 50_000 },
    ])
    expect(reclaimed).toEqual([])
    expect(guard.isLegacyOutpointKnown('aa.0')).toBe(true)
    expect(guard.legacySweepRetryEligible('aa.0')).toBe(false)
  })

  it('keeps the grace window across a reload', async () => {
    const guard = await import('./legacyImportGuard')
    guard.markLegacyImported(['aa.0'])
    vi.resetModules()

    const guard2 = await import('./legacyImportGuard')
    // A fresh process has no in-memory timestamp — the durable record supplies it.
    expect(guard2.isLegacyImportGraceActive()).toBe(true)
  })

  it('stores the sweep txid so a retry can check the chain', async () => {
    const guard = await import('./legacyImportGuard')
    guard.markLegacyImported([{ outpoint: 'aa.0', txid: 'A'.repeat(64) }])
    expect(guard.legacySweepRecord('aa.0')?.txid).toBe('a'.repeat(64))
  })

  it('migrates v1 marks and treats them as retry eligible', async () => {
    store.set(
      'handcash.brc100.importedLegacyOutpoints.v1',
      JSON.stringify(['aa.0', 'bb.1']),
    )
    const guard = await import('./legacyImportGuard')
    expect(guard.isLegacyOutpointKnown('aa.0')).toBe(true)
    expect(guard.legacySweepRetryEligible('aa.0')).toBe(true)
    expect(guard.isLegacyImportGraceActive()).toBe(false)
  })
})
