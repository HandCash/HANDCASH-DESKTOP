import { describe, expect, it } from 'vitest'
import {
  EXISTING_WALLET_MODE,
  OTHER_SIGNIN_MODE,
  firstSigninStep,
  formModeAfterGoogle,
  initialFormMode,
  isRestoreMethod,
} from './authModes'

describe('auth screen defaults', () => {
  it('a new install still opens on Create wallet', () => {
    expect(initialFormMode({ mode: 'onboarding', recoveryOnly: false })).toBe('create')
    expect(initialFormMode({ mode: 'locked', recoveryOnly: false })).toBe('unlock')
    expect(initialFormMode({ mode: 'onboarding', recoveryOnly: true })).toBe('phrase')
  })

  it('an existing wallet opens HandCash sign-in first, not Google or recovery', () => {
    expect(EXISTING_WALLET_MODE).toBe('signin')
  })

  it('inside sign-in, scanning over the local network comes first and email is the fallback', () => {
    expect(firstSigninStep(['http://192.168.1.20:3340'])).toBe('scan')
    expect(firstSigninStep([])).toBe('email')
  })

  it('Google and recovery sit behind Other ways to sign in', () => {
    expect(isRestoreMethod(OTHER_SIGNIN_MODE)).toBe(true)
    expect(formModeAfterGoogle({ mode: 'onboarding', recoveryOnly: false })).toBe(OTHER_SIGNIN_MODE)
    expect(formModeAfterGoogle({ mode: 'locked', recoveryOnly: false })).toBe('unlock')
  })
})
