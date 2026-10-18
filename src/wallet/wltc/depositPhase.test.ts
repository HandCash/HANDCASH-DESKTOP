import { describe, expect, it } from 'vitest'
import { describeLtcDeposit, ltcDepositCount, ltcDepositWaiting } from './depositPhase'

const at = Date.now()

describe('LTC deposit phase', () => {
  it('fills only the confirmations its own header chain counted', () => {
    expect(ltcDepositCount({ kind: 'confirming', confirmations: 3, needed: 6, height: 10, checkedAt: at })).toEqual({ counted: 3, needed: 6 })
    expect(ltcDepositCount({ kind: 'confirming', confirmations: 9, needed: 6, height: 10, checkedAt: at })).toEqual({ counted: 6, needed: 6 })
    expect(ltcDepositCount({ kind: 'unconfirmed', checkedAt: at })).toEqual({ counted: 0, needed: 6 })
    expect(ltcDepositCount({ kind: 'unchecked', since: at, last: { confirmations: 2, needed: 6, height: 10, checkedAt: at } })).toEqual({ counted: 2, needed: 6 })
    expect(ltcDepositCount({ kind: 'missing', since: at })).toEqual({ counted: 0, needed: 6 })
  })

  it('says who established each state and labels every time estimate', () => {
    const counted = describeLtcDeposit({ kind: 'confirming', confirmations: 3, needed: 6, height: 10, checkedAt: at })
    expect(counted.status).toBe('3 of 6 Litecoin confirmations')
    expect(counted.source).toMatch(/own Litecoin header chain/)
    expect(counted.estimate).toMatch(/^About 8 min more, if blocks keep/)

    const behind = describeLtcDeposit({ kind: 'confirming', confirmations: 0, needed: 6, height: 3_200_000, checkedAt: at })
    expect(behind.status).toBe(`In Litecoin block ${(3_200_000).toLocaleString()}`)
    expect(behind.source).toMatch(/has not reached that block/)

    const stale = describeLtcDeposit({ kind: 'unchecked', since: at, last: { confirmations: 2, needed: 6, height: 10, checkedAt: at } })
    expect(stale.status).toMatch(/^Last counted 2 of 6/)
    expect(stale.estimate).toBeNull()
  })

  it('never claims a vanished deposit left Litecoin for good', () => {
    const gone = describeLtcDeposit({ kind: 'abandoned', since: at })
    expect(gone.status).toMatch(/^Not seen on Litecoin since/)
    expect(gone.source).toMatch(/unless the deposit reaches a Litecoin block/)
    expect(ltcDepositWaiting({ kind: 'abandoned', since: at })).toBe(true)
    expect(ltcDepositWaiting({ kind: 'movable' })).toBe(false)
  })
})
