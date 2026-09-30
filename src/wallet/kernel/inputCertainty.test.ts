import { describe, expect, it } from 'vitest'
import { judgeInputCertainty, type CertaintyInput } from './inputCertainty'

const A = `${'aa'.repeat(32)}.0`
const B = `${'bb'.repeat(32)}.1`
const PARENT = 'cc'.repeat(32)
const SPENDER = 'dd'.repeat(32)

const mined = (
  outpoint: string,
  answer: Extract<CertaintyInput, { origin: 'mined' }>['answer'],
): CertaintyInput => ({
  outpoint,
  origin: 'mined',
  answer,
})
const chained = (
  outpoint: string,
  standing: 'certified' | 'landed' | 'rejected' | 'unlanded',
): CertaintyInput => ({ outpoint, origin: 'chained', parent: PARENT, standing })

describe('judgeInputCertainty', () => {
  it('is certain only when every coin is cleared or rides a vouched parent', () => {
    expect(
      judgeInputCertainty([
        mined(A, { kind: 'cleared' }),
        chained(B, 'certified'),
      ]),
    ).toEqual({ kind: 'certain' })
    expect(judgeInputCertainty([chained(B, 'landed')])).toEqual({ kind: 'certain' })
  })

  it('retires named dead coins and rejected parents before anything else', () => {
    expect(
      judgeInputCertainty([
        mined(A, { kind: 'spent', spender: SPENDER }),
        chained(B, 'rejected'),
        mined(`${'ee'.repeat(32)}.0`, { kind: 'unknown' }),
      ]),
    ).toEqual({
      kind: 'retire',
      spends: [{ outpoint: A, spender: SPENDER }],
      deadParents: [PARENT],
    })
  })

  it('refuses a coin nobody answered for', () => {
    expect(judgeInputCertainty([mined(A, { kind: 'unknown' })])).toEqual({
      kind: 'uncertain',
      reason: 'explorer-silent',
      outpoints: [A],
    })
  })

  it('names a parent still waiting on a node ahead of a silent explorer', () => {
    expect(
      judgeInputCertainty([mined(A, { kind: 'unknown' }), chained(B, 'unlanded')]),
    ).toEqual({ kind: 'uncertain', reason: 'parent-unlanded', outpoints: [B, A] })
  })
})
