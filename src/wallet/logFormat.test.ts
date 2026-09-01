import { describe, expect, it } from 'vitest'
import { formatLogArg, formatLogFields } from './logFormat'

describe('logFormat', () => {
  it('formats Capacitor-style error objects', () => {
    expect(formatLogArg({ code: 'UNIMPLEMENTED', message: 'not available' })).toBe(
      'UNIMPLEMENTED: not available',
    )
  })

  it('formats Error with code', () => {
    const err = new Error('boom') as Error & { code: string }
    err.code = 'INSUFFICIENT_FUNDS'
    expect(formatLogArg(err)).toContain('INSUFFICIENT_FUNDS')
    expect(formatLogArg(err)).toContain('boom')
  })

  it('joins diagnostic fields and skips empties', () => {
    expect(
      formatLogFields({
        spendable: 2,
        pendingChange: 162767,
        displayed: 162769,
        note: '',
        missing: undefined,
      }),
    ).toBe('spendable=2 pendingChange=162767 displayed=162769')
  })
})
