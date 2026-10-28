import { describe, expect, it } from 'vitest'
import { onboardEntryKind, showOnboardEntry } from './onboardEntry'

describe('onboard entry kind', () => {
  it('unsigned shows Sign in + Create', () => {
    expect(onboardEntryKind(false)).toBe('unsigned')
  })

  it('signed-in shows Migrate only (Create hidden)', () => {
    expect(onboardEntryKind(true)).toBe('signed-in')
  })

  it('onboarding without recovery-only opens the entry chooser', () => {
    expect(showOnboardEntry({ mode: 'onboarding', recoveryOnly: false })).toBe(true)
    expect(showOnboardEntry({ mode: 'onboarding', recoveryOnly: true })).toBe(false)
    expect(showOnboardEntry({ mode: 'locked', recoveryOnly: false })).toBe(false)
  })
})
