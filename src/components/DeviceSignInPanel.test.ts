import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = fs.readFileSync(path.join(__dirname, 'DeviceSignInPanel.tsx'), 'utf8')

describe('device sign-in entry', () => {
  it('is the QR plus the typed code: no email entry, no email code, no relay step', () => {
    expect(source).not.toMatch(/type="email"/)
    expect(source).not.toMatch(/requestSigninCode|startNewDeviceSignin|autoComplete="one-time-code"/)
    expect(source).not.toMatch(/step: 'email'|step: 'code'|step: 'relay'/)
  })

  it('never hands a signin email to the caller', () => {
    expect(source).toMatch(/signinEmail: null/)
    expect(source).not.toMatch(/signinEmail: email/)
  })
})
