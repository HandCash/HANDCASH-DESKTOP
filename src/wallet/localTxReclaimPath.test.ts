import { describe, expect, it } from 'vitest'
import { chooseLocalTxReclaimPath } from './localTxReclaimPath'

const stuck = {
  onChain: false as boolean | null,
  inputsFate: 'unspent' as const,
  arcadeContacted: false,
}

describe('chooseLocalTxReclaimPath', () => {
  it('takes back coins sealed for a transfer nobody published', () => {
    expect(chooseLocalTxReclaimPath(stuck)).toEqual({
      path: 'reclaimInputs',
      reason: 'neverReachedChain',
    })
  })

  it('never reclaims against a transaction that is on chain', () => {
    expect(chooseLocalTxReclaimPath({ ...stuck, onChain: true })).toEqual({
      path: 'refuse',
      reason: 'onChain',
    })
  })

  it('refuses when no explorer could answer', () => {
    expect(chooseLocalTxReclaimPath({ ...stuck, onChain: null })).toEqual({
      path: 'refuse',
      reason: 'statusUnknown',
    })
  })

  it('treats an unreadable input set as a refusal, not as unspent', () => {
    expect(
      chooseLocalTxReclaimPath({ ...stuck, inputsFate: 'unknown' }),
    ).toEqual({ path: 'refuse', reason: 'statusUnknown' })
  })

  it('has nothing to reclaim once the inputs moved', () => {
    expect(chooseLocalTxReclaimPath({ ...stuck, inputsFate: 'spent' })).toEqual({
      path: 'refuse',
      reason: 'inputsSpentOnChain',
    })
  })

  it('leaves an unsigned attempt to reservation repair', () => {
    expect(
      chooseLocalTxReclaimPath({ ...stuck, inputsFate: 'unsigned' }),
    ).toEqual({ path: 'refuse', reason: 'nothingSigned' })
  })

  it('waits while Arcade may still be submitting it', () => {
    expect(
      chooseLocalTxReclaimPath({ ...stuck, arcadeContacted: true }),
    ).toEqual({ path: 'refuse', reason: 'arcadeContacted' })
  })
})
