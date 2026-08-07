import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

describe('verificationProgress', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('setVerificationProgress does not pin awaiting forever', async () => {
    const vp = await import('./verificationProgress')
    vp.resetVerificationProgressForTests()
    vp.setVerificationProgress('verifying', 'aa.0', 'walk')
    expect(vp.isOutpointVerifying('aa.0')).toBe(true)
    vp.clearVerificationProgress('aa.0')
    expect(vp.isOutpointVerifying('aa.0')).toBe(false)
  })

  it('receive awaiting stays until cleared, not until progress idle', async () => {
    const vp = await import('./verificationProgress')
    vp.resetVerificationProgressForTests()
    vp.noteAwaitingVerification('bb.1')
    expect(vp.isOutpointVerifying('bb.1')).toBe(true)
    vp.clearVerificationProgress()
    expect(vp.isOutpointVerifying('bb.1')).toBe(true)
    vp.clearAwaitingVerification('bb.1')
    expect(vp.isOutpointVerifying('bb.1')).toBe(false)
  })

  it('proven tips self-heal a stale awaiting spinner', async () => {
    const cache = await import('./provenCache')
    const vp = await import('./verificationProgress')
    vp.resetVerificationProgressForTests()
    cache.rememberProvenVerdict('cc.2', { tier: 'brc150', verifiedAt: 1 })
    vp.noteAwaitingVerification('cc.2')
    // noteAwaiting ignores already-proven; force stale set via receive-before-prove path
    // by clearing memory and re-importing is awkward — call isOutpointVerifying after
    // manually noting then proving.
    const vp2 = await import('./verificationProgress')
    vp2.resetVerificationProgressForTests()
    // Simulate stale awaiting left from before the verdict stuck.
    ;(vp2 as { noteAwaitingVerification: (o: string) => void }).noteAwaitingVerification(
      'dd.3',
    )
    cache.rememberProvenVerdict('dd.3', { tier: 'brc150', verifiedAt: 2 })
    expect(vp2.isOutpointVerifying('dd.3')).toBe(false)
  })
})
