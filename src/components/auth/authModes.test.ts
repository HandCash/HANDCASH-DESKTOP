import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EXISTING_WALLET_MODE,
  OTHER_SIGNIN_MODE,
  RESTORE_METHODS,
  firstSigninStep,
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

  it('recovery sits behind Other ways to sign in, phrase first', () => {
    expect(OTHER_SIGNIN_MODE).toBe('phrase')
    expect(isRestoreMethod(OTHER_SIGNIN_MODE)).toBe(true)
  })

  it('the restore methods never offer Google recovery', () => {
    expect(RESTORE_METHODS.map((m) => m.id)).toEqual(['phrase', 'shares', 'key'])
  })
})

describe('Google recovery is gone from the auth screens', () => {
  const source = (file: string) =>
    fs.readFileSync(path.resolve(process.cwd(), 'src/components', file), 'utf8')

  it('the auth screen has no Google mode or panel', () => {
    const auth = source('AuthScreen.tsx')
    expect(auth).not.toMatch(/['"]google['"]/)
    expect(auth).not.toMatch(/GoogleLoginPanel|>\s*Google\s*</)
    expect(fs.existsSync(path.resolve(process.cwd(), 'src/components/GoogleLoginPanel.tsx'))).toBe(false)
  })

  it('sign-in offers only the recovery phrase when no device can approve', () => {
    const signin = source('DeviceSignInPanel.tsx')
    expect(signin).not.toContain('Use HandCash Recovery')
    expect(signin).toContain('Use recovery phrase')
  })
})
