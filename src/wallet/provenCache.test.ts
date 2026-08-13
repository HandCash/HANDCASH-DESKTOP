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

  it('does not promote legacy shape-only true verdicts into BRC-150', async () => {
    store.set(
      'handcash.collectables.proven.v1',
      JSON.stringify({ 'aa.0': true, 'bb.1': false }),
    )
    const cache = await import('./provenCache')
    expect(cache.hasProvenVerdict('aa.0')).toBe(false)
    expect(cache.getProvenVerdict('bb.1')?.tier).toBe('unproven')
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

  it('records the exact proof tier and hardened origin commitment', async () => {
    const cache = await import('./provenCache')
    cache.rememberProvenVerdict('cc.2', {
      tier: 'brc150',
      originScriptHash: 'dd'.repeat(32),
      verifiedAt: 123,
    })

    expect(cache.getProvenVerdict('CC_2')).toEqual({
      tier: 'brc150',
      originScriptHash: 'dd'.repeat(32),
      verifiedAt: 123,
    })
    expect(cache.isItemProven('cc.2')).toBe(true)
  })

  it('does not downgrade a proven tier to unproven', async () => {
    const cache = await import('./provenCache')
    cache.rememberProvenVerdict('ee.3', {
      tier: 'brc150',
      origin: 'aa_0',
      verifiedAt: 1,
    })
    cache.rememberProvenVerdict('ee.3', false)
    expect(cache.getProvenVerdict('ee.3')?.tier).toBe('brc150')
    expect(cache.isItemProven('ee.3')).toBe(true)
  })

  it('rehydrates authenticityFromProvenCache for list paint', async () => {
    const cache = await import('./provenCache')
    cache.rememberProvenVerdict('ff.4', { tier: 'brc150', verifiedAt: 2 })
    expect(cache.authenticityFromProvenCache('FF_4')).toEqual({
      authenticity: 'brc150',
      proven: true,
    })
  })

  it('pins one immutable script hash per origin', async () => {
    const cache = await import('./provenCache')
    cache.rememberOriginCommitment('AA.0', '11'.repeat(32))
    expect(cache.getOriginCommitment('aa_0')).toBe('11'.repeat(32))
    expect(() =>
      cache.rememberOriginCommitment('aa_0', '22'.repeat(32)),
    ).toThrow(/changed/i)
  })
})

describe('the path a proof walked', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  // A restart used to leave the wallet knowing an item was genuine but unable
  // to say why, so it sent the item bare and the receiver walked it all again.
  it('outlives the session that proved it', async () => {
    const path = ['bb_0', 'aa_0']
    const first = await import('./provenCache')
    first.rememberProvenVerdict('bb.0', {
      tier: 'brc150',
      origin: 'aa_0',
      path,
      verifiedAt: 1,
    })

    vi.resetModules()
    const restarted = await import('./provenCache')
    expect(restarted.getProvenVerdict('bb.0')?.path).toEqual(path)
  })

  it('is kept when a later write only carries the tier', async () => {
    const cache = await import('./provenCache')
    cache.rememberProvenVerdict('bb.0', {
      tier: 'brc150',
      origin: 'aa_0',
      path: ['bb_0', 'aa_0'],
      verifiedAt: 1,
    })
    cache.rememberProvenVerdict('bb.0', 'brc150')

    expect(cache.getProvenVerdict('bb.0')?.path).toEqual(['bb_0', 'aa_0'])
  })
})

describe('recovering the path of an already-proven tip', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  // Verdicts written before the path was recorded would otherwise never walk
  // again, so those items would send bare forever.
  it('allows one walk for a proven tip with no path', async () => {
    const cache = await import('./provenCache')
    cache.rememberProvenVerdict('bb.0', {
      tier: 'brc150',
      origin: 'aa_0',
      verifiedAt: 1,
    })

    expect(cache.shouldAttemptGenesis('bb.0')).toBe(true)
  })

  it('leaves a proven tip alone once its path is known', async () => {
    const cache = await import('./provenCache')
    cache.rememberProvenVerdict('bb.0', {
      tier: 'brc150',
      origin: 'aa_0',
      path: ['bb_0', 'aa_0'],
      verifiedAt: 1,
    })

    expect(cache.shouldAttemptGenesis('bb.0')).toBe(false)
  })

  // Otherwise a tip that cannot be fetched retries on every list and spends the
  // walk budget that unproven tips need to earn a badge at all.
  it('paces the retry after a failed recovery', async () => {
    const cache = await import('./provenCache')
    const now = Date.now()
    cache.rememberProvenVerdict('bb.0', {
      tier: 'brc150',
      origin: 'aa_0',
      verifiedAt: 1,
    })
    cache.rememberGenesisAttempt('bb.0', now)

    expect(cache.shouldAttemptGenesis('bb.0', now + 60_000)).toBe(false)
    expect(
      cache.shouldAttemptGenesis('bb.0', now + cache.GENESIS_PATH_BACKFILL_MS),
    ).toBe(true)
    // ...and sooner than an unprovable tip would wait.
    expect(cache.GENESIS_PATH_BACKFILL_MS).toBeLessThan(cache.GENESIS_RETRY_MS)
  })
})
