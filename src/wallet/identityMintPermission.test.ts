import { describe, expect, it } from 'vitest'
import { summarizeAction } from './permissions'

describe('payment permission copy', () => {
  it('keeps ordinary payments as Approve payment', () => {
    const summarized = summarizeAction('createAction', {
      description: 'Coffee',
      outputs: [{ satoshis: 1000, outputDescription: 'Pay' }],
    })
    expect(summarized.title).toBe('Approve payment')
  })
})
