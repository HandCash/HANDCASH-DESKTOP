import { describe, expect, it } from 'vitest'
import { resolveAeonColorMode } from './theme.js'

describe('resolveAeonColorMode', () => {
  it('maps explicit themes', () => {
    expect(resolveAeonColorMode('light', true)).toBe('light')
    expect(resolveAeonColorMode('dark', false)).toBe('dark')
  })

  it('falls back to system for system theme', () => {
    expect(resolveAeonColorMode('system', true)).toBe('dark')
    expect(resolveAeonColorMode(undefined, false)).toBe('light')
  })
})
