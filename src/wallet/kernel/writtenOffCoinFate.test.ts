import { describe, expect, it } from 'vitest'
import {
  decideWrittenOffCoinFate,
  isWrittenOffCandidate,
  type WrittenOffCoinFacts,
} from './writtenOffCoinFate'

const settled: WrittenOffCoinFacts = {
  satoshis: 95_018,
  creator: 'settled',
  spentLocally: false,
  overlayHeld: false,
  hasScript: true,
}
const spender = 'd65f31d0'.repeat(8)

describe('isWrittenOffCandidate', () => {
  it('takes unspendable coins of settled or live creators with no local spender', () => {
    expect(isWrittenOffCandidate(settled)).toBe(true)
    expect(isWrittenOffCandidate({ ...settled, creator: 'pending' })).toBe(true)
  })

  it('leaves signed-cheque claims, overlay seals, failed creators and empty rows alone', () => {
    expect(isWrittenOffCandidate({ ...settled, spentLocally: true })).toBe(false)
    expect(isWrittenOffCandidate({ ...settled, overlayHeld: true })).toBe(false)
    expect(isWrittenOffCandidate({ ...settled, creator: 'dead' })).toBe(false)
    expect(isWrittenOffCandidate({ ...settled, creator: 'none' })).toBe(false)
    expect(isWrittenOffCandidate({ ...settled, satoshis: 0 })).toBe(false)
  })
})

describe('decideWrittenOffCoinFate', () => {
  it('restores a written-off coin of a settled creator the chain calls unspent', () => {
    expect(decideWrittenOffCoinFate(settled, { kind: 'unspent' })).toEqual({ kind: 'restore' })
  })

  it('hides change the chain shows spent by a transaction this wallet never stored', () => {
    const fate = decideWrittenOffCoinFate(
      { ...settled, creator: 'pending', satoshis: 133_712 },
      { kind: 'spent', spender, spenderIsLocal: false },
    )
    expect(fate).toEqual({ kind: 'hide', spender })
  })

  it('keeps a coin spent by a local transaction for the local spend paths', () => {
    expect(
      decideWrittenOffCoinFate(settled, { kind: 'spent', spender, spenderIsLocal: true }),
    ).toEqual({ kind: 'keep', reason: 'spenderLocal' })
  })

  it('never restores on silence', () => {
    expect(decideWrittenOffCoinFate(settled, { kind: 'unknown' })).toEqual({
      kind: 'keep',
      reason: 'chainSilent',
    })
  })

  it('leaves unspent change of a live send to the spend-path promote', () => {
    expect(decideWrittenOffCoinFate({ ...settled, creator: 'pending' }, { kind: 'unspent' })).toEqual({
      kind: 'keep',
      reason: 'liveChange',
    })
  })

  it('never restores a script-less row', () => {
    expect(decideWrittenOffCoinFate({ ...settled, hasScript: false }, { kind: 'unspent' })).toEqual({
      kind: 'keep',
      reason: 'noScript',
    })
  })
})
