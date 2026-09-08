import { describe, expect, it } from 'vitest'
import { missingTxMayReject } from './txReconcile'

describe('missing transaction reconciliation', () => {
  const now = 2_000_000_000_000

  it('does not reject from explorer absence alone after the grace period', () => {
    expect(missingTxMayReject(now - 60 * 60_000, false, now)).toBe(false)
  })

  it('requires both an expired grace period and a proven conflicting spend', () => {
    expect(missingTxMayReject(now - 10 * 60_000, true, now)).toBe(false)
    expect(missingTxMayReject(now - 60 * 60_000, true, now)).toBe(true)
  })
})
