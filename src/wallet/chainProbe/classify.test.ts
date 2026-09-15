import { describe, expect, it } from 'vitest'
import { classifyBitailsUtxoStatus, spentStatusFromArcadeTxLookup } from './classify'

describe('spentStatusFromArcadeTxLookup', () => {
  it('never treats Arcade MINED / SEEN as output-spent', () => {
    expect(spentStatusFromArcadeTxLookup('MINED')).toBeNull()
    expect(spentStatusFromArcadeTxLookup('SEEN_ON_NETWORK')).toBeNull()
    expect(spentStatusFromArcadeTxLookup({ status: 'MINED' })).toBeNull()
  })
})

describe('classifyBitailsUtxoStatus', () => {
  it('treats a positive spent flag as spent', () => {
    expect(classifyBitailsUtxoStatus({ status: 'exists', spent: true })).toBe(
      'spent',
    )
  })

  it('treats exists/mempool plus spent false as unspent', () => {
    expect(classifyBitailsUtxoStatus({ status: 'exists', spent: false })).toBe(
      'unspent',
    )
  })

  it('fails closed on Bitails unknown', () => {
    expect(classifyBitailsUtxoStatus({ status: 'unknown' })).toBe('unknown')
  })
})
