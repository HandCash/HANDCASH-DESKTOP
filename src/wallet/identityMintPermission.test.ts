import { describe, expect, it } from 'vitest'
import { humanActionCopy } from './appIdentity'
import { summarizeAction } from './permissions'

describe('identity mint permission copy', () => {
  it('labels deploy+mint as Mint token backed by identity', () => {
    const summarized = summarizeAction('createAction', {
      description: 'Mint DEMO',
      outputs: [
        {
          satoshis: 1,
          basket: 'bsv21',
          tags: ['bsv21', 'op:deploy+mint', 'sym:DEMO', 'amt:1000'],
          customInstructions: JSON.stringify({
            p: 'bsv-20',
            op: 'deploy+mint',
            sym: 'DEMO',
            amt: '1000',
          }),
        },
      ],
    })
    expect(summarized.title).toBe('Mint token')
    expect(summarized.summary).toBe('Mint DEMO')
    expect(summarized.details.some((d) => /identity/i.test(d))).toBe(true)
    expect(summarized.details).toContain('Token: DEMO')
    expect(summarized.details.some((d) => /Auto-pay/i.test(d))).toBe(true)

    const copy = humanActionCopy('createAction', summarized.title)
    expect(copy.eyebrow).toBe('Identity mint')
    expect(copy.verb).toMatch(/backed by your identity/i)
  })

  it('keeps ordinary payments as Approve payment', () => {
    const summarized = summarizeAction('createAction', {
      description: 'Coffee',
      outputs: [{ satoshis: 1000, outputDescription: 'Pay' }],
    })
    expect(summarized.title).toBe('Approve payment')
  })
})
