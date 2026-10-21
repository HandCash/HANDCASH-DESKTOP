import { describe, expect, it } from 'vitest'
import { firstOnboardStep, masterKeyAlreadyBackedUp } from './onboardSteps'

describe('onboarding route', () => {
  it('a new vault asks for its key backup, or goes to what it accepts without a phrase', () => {
    expect(firstOnboardStep('create', true)).toBe('keys-backup')
    expect(firstOnboardStep('create', false)).toBe('accept')
    expect(masterKeyAlreadyBackedUp('create')).toBe(false)
  })

  it('a restore skips the key backup and starts at history', () => {
    expect(firstOnboardStep('restore', true)).toBe('history')
    expect(masterKeyAlreadyBackedUp('restore')).toBe(true)
  })

  it('a device joined by approval opens at once, its master already backed up', () => {
    expect(firstOnboardStep('joined', true)).toBeNull()
    expect(firstOnboardStep('joined', false)).toBeNull()
    expect(masterKeyAlreadyBackedUp('joined')).toBe(true)
  })
})
