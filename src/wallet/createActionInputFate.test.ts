import { describe, expect, it } from 'vitest'
import { parseConfirmedForeignSpender } from './createActionInputFate'

const SELF = 'aa'.repeat(32)
const OTHER = 'bb'.repeat(32)

describe('parseConfirmedForeignSpender', () => {
  it('names a confirmed spender that is not this transaction', () => {
    expect(
      parseConfirmedForeignSpender(
        { txid: OTHER, status: 'confirmed' },
        SELF,
      ),
    ).toBe(OTHER)
  })

  it('ignores a spend by this transaction and anything not confirmed', () => {
    expect(
      parseConfirmedForeignSpender({ txid: SELF, status: 'confirmed' }, SELF),
    ).toBeNull()
    expect(
      parseConfirmedForeignSpender(
        { txid: OTHER, status: 'unconfirmed' },
        SELF,
      ),
    ).toBeNull()
    expect(parseConfirmedForeignSpender({ status: 'confirmed' }, SELF)).toBeNull()
    expect(parseConfirmedForeignSpender(null, SELF)).toBeNull()
  })
})
