import { describe, expect, it } from 'vitest'
import { applyAmountPadKey } from './amountPadKey'

describe('applyAmountPadKey', () => {
  it('appends digits', () => {
    expect(applyAmountPadKey('', '1')).toBe('1')
    expect(applyAmountPadKey('12', '3')).toBe('123')
  })

  it('replaces a lone leading zero', () => {
    expect(applyAmountPadKey('0', '5')).toBe('5')
    expect(applyAmountPadKey('0.', '0')).toBe('0.0')
  })

  it('allows one decimal point and starts an empty amount at 0.', () => {
    expect(applyAmountPadKey('', '.')).toBe('0.')
    expect(applyAmountPadKey('1.5', '.')).toBe('1.5')
  })

  it('deletes the last character', () => {
    expect(applyAmountPadKey('1.5', 'back')).toBe('1.')
    expect(applyAmountPadKey('', 'back')).toBe('')
  })
})
