import { describe, expect, it } from 'vitest'
import type { OutpointSpendProbe } from '../createActionInputFate'
import { chooseAbsentCardFate } from './absentCardFate'

const A = `${'a'.repeat(64)}.0`
const B = `${'b'.repeat(64)}.1`
const SPENDER = 'c'.repeat(64)

function probes(entries: Array<[string, OutpointSpendProbe]>) {
  return new Map(entries)
}

describe('chooseAbsentCardFate', () => {
  it('retires a card only when every tip is proven spent', () => {
    expect(
      chooseAbsentCardFate([A, B], probes([[A, { kind: 'spent', spender: SPENDER }], [B, { kind: 'spent', spender: SPENDER }]])),
    ).toEqual({ kind: 'retire', spenders: [SPENDER, SPENDER] })
  })

  it('keeps a card while any tip has no answer', () => {
    expect(
      chooseAbsentCardFate([A, B], probes([[A, { kind: 'spent', spender: SPENDER }], [B, { kind: 'unknown' }]])),
    ).toEqual({ kind: 'keep', reason: 'spend-unknown' })
    expect(chooseAbsentCardFate([A], probes([]))).toEqual({ kind: 'keep', reason: 'spend-unknown' })
  })

  it('reclaims the transactions of unspent tips', () => {
    expect(
      chooseAbsentCardFate([A, B], probes([[A, { kind: 'unspent' }], [B, { kind: 'spent', spender: SPENDER }]])),
    ).toEqual({ kind: 'reclaim', txids: ['a'.repeat(64)] })
  })

  it('keeps a card with no tip to ask about', () => {
    expect(chooseAbsentCardFate([], probes([]))).toEqual({ kind: 'keep', reason: 'no-tips' })
  })
})
