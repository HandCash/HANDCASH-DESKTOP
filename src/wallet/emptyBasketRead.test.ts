import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_READ_CONFIRM_MS, createEmptyReadGate, judgeEmptyRead } from './emptyBasketRead'

describe('judgeEmptyRead', () => {
  it('judges a read that listed something, or held nothing, as usual', () => {
    expect(judgeEmptyRead({ listed: 2, held: 3, emptySince: 5, now: 10 })).toEqual({ kind: 'listed' })
    expect(judgeEmptyRead({ listed: 0, held: 0, emptySince: null, now: 10 })).toEqual({ kind: 'listed' })
  })

  it('waits on the first empty read beside held cards', () => {
    expect(judgeEmptyRead({ listed: 0, held: 2, emptySince: null, now: 1_000 })).toEqual({
      kind: 'wait',
      since: 1_000,
      confirmInMs: EMPTY_READ_CONFIRM_MS,
    })
  })

  it('keeps waiting inside the window and confirms once it has passed', () => {
    expect(judgeEmptyRead({ listed: 0, held: 2, emptySince: 1_000, now: 1_000 + EMPTY_READ_CONFIRM_MS - 1 })).toEqual({
      kind: 'wait',
      since: 1_000,
      confirmInMs: 1,
    })
    expect(judgeEmptyRead({ listed: 0, held: 2, emptySince: 1_000, now: 1_000 + EMPTY_READ_CONFIRM_MS })).toEqual({
      kind: 'confirmed',
      since: 1_000,
    })
  })
})

describe('createEmptyReadGate', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('asks again once, when the window has passed', () => {
    const relist = vi.fn()
    const gate = createEmptyReadGate(relist)

    expect(gate.judge(0, 2, 0).kind).toBe('wait')
    expect(gate.judge(0, 2, 10).kind).toBe('wait')
    vi.advanceTimersByTime(EMPTY_READ_CONFIRM_MS - 1)
    expect(relist).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(relist).toHaveBeenCalledTimes(1)
    expect(gate.judge(0, 2, EMPTY_READ_CONFIRM_MS).kind).toBe('confirmed')
  })

  it('starts over after a read that lists something', () => {
    const relist = vi.fn()
    const gate = createEmptyReadGate(relist)

    gate.judge(0, 2, 0)
    expect(gate.judge(1, 2, 5).kind).toBe('listed')
    vi.advanceTimersByTime(EMPTY_READ_CONFIRM_MS)
    expect(relist).not.toHaveBeenCalled()
    expect(gate.judge(0, 2, EMPTY_READ_CONFIRM_MS)).toEqual({
      kind: 'wait',
      since: EMPTY_READ_CONFIRM_MS,
      confirmInMs: EMPTY_READ_CONFIRM_MS,
    })
  })

  it('forgets a pending wait on reset', () => {
    const relist = vi.fn()
    const gate = createEmptyReadGate(relist)

    gate.judge(0, 2, 0)
    gate.reset()
    vi.advanceTimersByTime(EMPTY_READ_CONFIRM_MS)
    expect(relist).not.toHaveBeenCalled()
    expect(gate.judge(0, 2, EMPTY_READ_CONFIRM_MS).kind).toBe('wait')
  })
})
