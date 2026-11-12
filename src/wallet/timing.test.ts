import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sleep, timeoutSignal, withTimeout } from './timing'

describe('timing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sleep resolves after the delay', async () => {
    let done = false
    void sleep(100).then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(99)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
  })

  it('withTimeout passes the result through and clears its timer', async () => {
    await expect(withTimeout(Promise.resolve(7), 50)).resolves.toBe(7)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('withTimeout passes a rejection through', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 50)).rejects.toThrow('boom')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('withTimeout rejects with the message once the deadline passes', async () => {
    let rejectLate: (err: Error) => void = () => {}
    const work = new Promise<number>((_, reject) => {
      rejectLate = reject
    })
    const raced = withTimeout(work, 50, 'listOutputs timed out')
    const assertion = expect(raced).rejects.toThrow('listOutputs timed out')
    await vi.advanceTimersByTimeAsync(50)
    await assertion
    rejectLate(new Error('late'))
  })

  it('withTimeout defaults the message to "timeout"', async () => {
    const raced = withTimeout(new Promise<never>(() => {}), 10)
    const assertion = expect(raced).rejects.toThrow(/^timeout$/)
    await vi.advanceTimersByTimeAsync(10)
    await assertion
  })

  it('timeoutSignal returns an unaborted signal', () => {
    const signal = timeoutSignal(1_000)
    expect(signal?.aborted).toBe(false)
  })
})
