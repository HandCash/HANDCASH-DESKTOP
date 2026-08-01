/** New create / restore / change-password policy. */
export const PASSWORD_MIN_LENGTH = 10

/** Existing vaults may still unlock with the pre-policy floor. */
export const UNLOCK_PASSWORD_MIN_LENGTH = 8

export function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`
  }
  if (!/[a-zA-Z]/.test(password)) {
    return 'Password must include a letter'
  }
  if (!/[0-9]/.test(password)) {
    return 'Password must include a number'
  }
  return null
}

export function isPasswordStrongEnough(password: string): boolean {
  return validatePassword(password) === null
}
