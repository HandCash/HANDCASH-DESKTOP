import { describe, expect, it } from 'vitest'
import { formatPostBeefFailure, summarizePostBeef } from './postBeefResult'

describe('postBeefResult', () => {
  it('treats already-known / mempool as accepted', () => {
    expect(
      summarizePostBeef([
        {
          name: 'BitailsPostRaws',
          status: 'error',
          txidResults: [
            {
              status: 'success',
              alreadyKnown: true,
              notes: [{ what: 'postRawsSuccessAlreadyInMempool' }],
            },
          ],
        },
      ]).accepted,
    ).toBe(true)
  })

  it('detects missing-inputs as doubleSpend', () => {
    const s = summarizePostBeef([
      {
        name: 'BitailsPostRaws',
        status: 'error',
        txidResults: [
          {
            status: 'error',
            doubleSpend: true,
            notes: [{ what: 'postRawsErrorMissingInputs' }],
          },
        ],
      },
      { name: 'WoC', status: 'error', txidResults: [] },
    ])
    expect(s.accepted).toBe(false)
    expect(s.missingInputs).toBe(true)
    expect(s.doubleSpend).toBe(true)
    expect(formatPostBeefFailure(s)).toBe('Already spent')
  })

  it('does not throw when postBeef returns nothing', () => {
    const s = summarizePostBeef(undefined)
    expect(s.accepted).toBe(false)
    expect(s.serviceOnlyErrors).toBe(true)
  })
})
