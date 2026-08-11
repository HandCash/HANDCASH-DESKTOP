import { describe, expect, it } from 'vitest'
import { historyCryptoSecret } from './historyCryptoSecret'

describe('historyCryptoSecret', () => {
  const root =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

  it('is stable for the same root key', () => {
    expect(historyCryptoSecret(root)).toBe(historyCryptoSecret(root))
  })

  it('normalizes 0x / case', () => {
    expect(historyCryptoSecret(`0x${root.toUpperCase()}`)).toBe(
      historyCryptoSecret(root),
    )
  })

  it('differs across root keys', () => {
    const other =
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    expect(historyCryptoSecret(root)).not.toBe(historyCryptoSecret(other))
  })

  it('is 64 hex chars (sha256)', () => {
    expect(historyCryptoSecret(root)).toMatch(/^[0-9a-f]{64}$/)
  })
})
