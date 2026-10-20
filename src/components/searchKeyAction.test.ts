import { describe, expect, it } from 'vitest'
import { searchKeyAction } from './searchKeyAction'

describe('searchKeyAction', () => {
  it('clears a filled field on Escape', () => {
    expect(searchKeyAction('Escape', 'ape')).toBe('clear')
  })

  it('leaves an empty field on Escape', () => {
    expect(searchKeyAction('Escape', '')).toBe('leave')
  })

  it('ignores other keys', () => {
    expect(searchKeyAction('Enter', 'ape')).toBeNull()
    expect(searchKeyAction('a', '')).toBeNull()
  })
})
