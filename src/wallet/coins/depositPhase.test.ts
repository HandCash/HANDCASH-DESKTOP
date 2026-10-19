import { describe, expect, it } from 'vitest'
import { depositBlock, depositCount, depositWaiting, describeDeposit } from './depositPhase'

const at = Date.now()

describe('coin deposit phase', () => {
  it('fills only the confirmations its own header chain counted, out of the depth of its own chain', () => {
    expect(depositCount('ltc', { kind: 'confirming', confirmations: 3, needed: 6, height: 10, checkedAt: at })).toEqual({ counted: 3, needed: 6 })
    expect(depositCount('ltc', { kind: 'confirming', confirmations: 9, needed: 6, height: 10, checkedAt: at })).toEqual({ counted: 6, needed: 6 })
    expect(depositCount('ltc', { kind: 'unconfirmed', checkedAt: at })).toEqual({ counted: 0, needed: 6 })
    expect(depositCount('ltc', { kind: 'unchecked', since: at, last: { confirmations: 2, needed: 6, height: 10, checkedAt: at } })).toEqual({ counted: 2, needed: 6 })
    expect(depositCount('ltc', { kind: 'missing', since: at })).toEqual({ counted: 0, needed: 6 })
    expect(depositCount('btc', { kind: 'unconfirmed', checkedAt: at })).toEqual({ counted: 0, needed: 3 })
    expect(depositCount('doge', { kind: 'movable' })).toEqual({ counted: 20, needed: 20 })
  })

  it('says who established each state and labels every time estimate at its chain pace', () => {
    const counted = describeDeposit('ltc', { kind: 'confirming', confirmations: 3, needed: 6, height: 10, checkedAt: at })
    expect(counted.status).toBe('3 of 6 Litecoin confirmations')
    expect(counted.source).toMatch(/own Litecoin header chain/)
    expect(counted.estimate).toBe("About 8 min more, if blocks keep Litecoin's 2.5-minute pace")

    const behind = describeDeposit('ltc', { kind: 'confirming', confirmations: 0, needed: 6, height: 3_200_000, checkedAt: at })
    expect(behind.status).toBe(`In Litecoin block ${(3_200_000).toLocaleString()}`)
    expect(behind.source).toMatch(/has not reached that block/)

    const stale = describeDeposit('ltc', { kind: 'unchecked', since: at, last: { confirmations: 2, needed: 6, height: 10, checkedAt: at } })
    expect(stale.status).toMatch(/^Last counted 2 of 6/)
    expect(stale.estimate).toBeNull()

    expect(describeDeposit('doge', { kind: 'unconfirmed', checkedAt: at }).estimate).toBe("About 19 min after its first block, if blocks keep Dogecoin's 1-minute pace")
    expect(describeDeposit('btc', { kind: 'movable' }).source).toBe("3 or more confirmations on this wallet's own Bitcoin header chain")
  })

  it('never claims a vanished coin left its chain for good', () => {
    const gone = describeDeposit('bch', { kind: 'abandoned', since: at })
    expect(gone.status).toMatch(/^Not seen on Bitcoin Cash since/)
    expect(gone.source).toMatch(/unless the transaction reaches a Bitcoin Cash block/)
    expect(depositWaiting({ kind: 'abandoned', since: at })).toBe(true)
    expect(depositWaiting({ kind: 'movable' })).toBe(false)
  })

  it('names the block only once this wallet located it', () => {
    expect(depositBlock({ kind: 'confirming', confirmations: 1, needed: 6, height: 42, checkedAt: at })).toBe(42)
    expect(depositBlock({ kind: 'unchecked', since: at, last: { confirmations: 1, needed: 6, height: 41, checkedAt: at } })).toBe(41)
    expect(depositBlock({ kind: 'unconfirmed', checkedAt: at })).toBeUndefined()
  })
})
