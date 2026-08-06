import { describe, expect, it } from 'vitest'
import {
  formatDollarHandle,
  formatHandCashHandle,
  normalizeHandleName,
} from './handleFormat'

describe('handleFormat', () => {
  it('strips both $ and @ prefixes', () => {
    expect(normalizeHandleName('$Alice')).toBe('alice')
    expect(normalizeHandleName('@Alice')).toBe('alice')
    expect(normalizeHandleName('alice')).toBe('alice')
  })

  it('formats the HandCash product form with $', () => {
    expect(formatDollarHandle('alice')).toBe('$alice')
    expect(formatDollarHandle('$alice')).toBe('$alice')
  })

  it('omits the home domain by default and keeps foreign ones', () => {
    expect(formatHandCashHandle('alice', 'handcash.io')).toBe('$alice')
    expect(formatHandCashHandle('alice', 'other.tld')).toBe('$alice@other.tld')
    expect(formatHandCashHandle('alice', 'handcash.io', { fullyQualified: true })).toBe(
      '$alice@handcash.io',
    )
  })
})
