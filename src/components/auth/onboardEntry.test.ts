import { describe, expect, it } from 'vitest'
import { showOnboardEntry } from './onboardEntry'

describe('onboard entry', () => {
  it('onboarding without recovery-only opens the entry chooser', () => {
    expect(showOnboardEntry({ mode: 'onboarding', recoveryOnly: false })).toBe(true)
    expect(showOnboardEntry({ mode: 'onboarding', recoveryOnly: true })).toBe(false)
    expect(showOnboardEntry({ mode: 'locked', recoveryOnly: false })).toBe(false)
  })
})
