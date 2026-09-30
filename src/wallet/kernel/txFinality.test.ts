import { describe, expect, it } from 'vitest'
import {
  judgeFinality,
  LOCKTIME_THRESHOLD,
  MEDIAN_TIME_LAG_S,
  SEQUENCE_FINAL,
  type FinalityTx,
} from './txFinality'

const tx = (lockTime: number, sequences: number[]): FinalityTx => ({ txid: 'aa'.repeat(32), lockTime, sequences })
const tip = { height: 900_000, nowSec: 1_800_000_000 }

describe('judgeFinality', () => {
  it('needs no tip for a zero lock time or all-final sequences', () => {
    expect(judgeFinality([tx(0, [0]), tx(950_000, [SEQUENCE_FINAL])], null)).toEqual({ kind: 'final' })
  })

  it('asks for the tip only when a lock time is live', () => {
    expect(judgeFinality([tx(899_000, [0])], null)).toBeNull()
  })

  it('takes a height lock as final once the next block can include it', () => {
    expect(judgeFinality([tx(900_000, [0])], tip)).toEqual({ kind: 'final' })
    expect(judgeFinality([tx(900_001, [0])], tip)).toMatchObject({ kind: 'nonFinal', by: 'height', lockTime: 900_001 })
  })

  it('reads a time lock against median time past, not the wall clock', () => {
    const justPast = tip.nowSec - 60
    expect(justPast).toBeGreaterThanOrEqual(LOCKTIME_THRESHOLD)
    expect(judgeFinality([tx(justPast, [1])], tip)).toMatchObject({ kind: 'nonFinal', by: 'time' })
    expect(judgeFinality([tx(tip.nowSec - MEDIAN_TIME_LAG_S - 1, [1])], tip)).toEqual({ kind: 'final' })
  })

  it('refuses the package when any unmined ancestor is non-final', () => {
    const parent = { ...tx(950_000, [5]), txid: 'bb'.repeat(32) }
    expect(judgeFinality([tx(0, [0]), parent], tip)).toMatchObject({ kind: 'nonFinal', txid: parent.txid })
  })
})
