import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isInputActive, noteInputForTest, whenInputQuiet } from './inputQuiet'

describe('background work waits for scrolling to stop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts at once when nobody is scrolling', async () => {
    vi.advanceTimersByTime(1_000)
    expect(isInputActive()).toBe(false)
    let started = false
    void whenInputQuiet().then(() => {
      started = true
    })
    await Promise.resolve()
    expect(started).toBe(true)
  })

  it('waits out a scroll, then starts', async () => {
    noteInputForTest()
    expect(isInputActive()).toBe(true)
    let started = false
    void whenInputQuiet().then(() => {
      started = true
    })
    await vi.advanceTimersByTimeAsync(100)
    noteInputForTest()
    await vi.advanceTimersByTimeAsync(150)
    expect(started).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(started).toBe(true)
  })

  it('never starves behind endless scrolling', async () => {
    let started = false
    noteInputForTest()
    void whenInputQuiet(500).then(() => {
      started = true
    })
    for (let i = 0; i < 10 && !started; i++) {
      await vi.advanceTimersByTimeAsync(60)
      noteInputForTest()
    }
    expect(started).toBe(true)
  })
})
