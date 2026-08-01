import { describe, expect, it } from 'vitest'
import { PASSWORD_MIN_LENGTH, validatePassword } from './passwordPolicy'

describe('validatePassword', () => {
  it('requires minimum length, a letter, and a number', () => {
    expect(validatePassword('short1A')).toMatch(/at least/)
    expect(validatePassword('a'.repeat(PASSWORD_MIN_LENGTH))).toMatch(/number/)
    expect(validatePassword('1'.repeat(PASSWORD_MIN_LENGTH))).toMatch(/letter/)
    expect(validatePassword('password12')).toBeNull()
  })
})
