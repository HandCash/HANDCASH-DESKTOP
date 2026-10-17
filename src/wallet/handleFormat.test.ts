import { describe, expect, it } from 'vitest'
import {
  formatDollarHandle,
  formatHandCashHandle,
  normalizeHandleName,
} from './handleFormat'

describe('handleFormat', () => {
  it('strips @$, $, and @ prefixes', () => {
    expect(normalizeHandleName('@$Alice')).toBe('alice')
    expect(normalizeHandleName('$Alice')).toBe('alice')
    expect(normalizeHandleName('@Alice')).toBe('alice')
    expect(normalizeHandleName('alice')).toBe('alice')
  })

  it('formats the short HandCash form with $ only', () => {
    expect(formatDollarHandle('alice')).toBe('$alice')
    expect(formatDollarHandle('$alice')).toBe('$alice')
    expect(formatDollarHandle('@$alice')).toBe('$alice')
    expect(formatDollarHandle('@alice')).toBe('$alice')
  })

  it('uses @handle@domain email grammar when fully qualified', () => {
    expect(formatHandCashHandle('alice', 'brc-cloud.bcryderman.workers.dev')).toBe('$alice')
    expect(formatHandCashHandle('alice', 'other.tld')).toBe('@alice@other.tld')
    expect(formatHandCashHandle('alice', 'brc-cloud.bcryderman.workers.dev', { fullyQualified: true })).toBe(
      '@alice@brc-cloud.bcryderman.workers.dev',
    )
  })
})
