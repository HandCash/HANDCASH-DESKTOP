import { describe, expect, it } from 'vitest'
import { mapPool } from './asyncPool'

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('mapPool', () => {
  it('returns results in input order regardless of completion order', async () => {
    const out = await mapPool([30, 5, 20, 1], 4, async (ms, i) => {
      await tick(ms)
      return `${i}:${ms}`
    })
    expect(out).toEqual(['0:30', '1:5', '2:20', '3:1'])
  })

  it('never exceeds the concurrency ceiling', async () => {
    let inFlight = 0
    let peak = 0
    await mapPool(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await tick(5)
      inFlight -= 1
    })
    expect(peak).toBe(3)
  })

  it('does actually run work in parallel', async () => {
    const started = Date.now()
    await mapPool([25, 25, 25], 3, async (ms) => tick(ms))
    // Serial would be ~75ms; parallel is one slice plus scheduling slack.
    expect(Date.now() - started).toBeLessThan(70)
  })

  it('handles an empty queue without spawning workers', async () => {
    expect(await mapPool([], 4, async () => 'nope')).toEqual([])
  })

  it('clamps concurrency to at least one worker', async () => {
    expect(await mapPool([1, 2], 0, async (n) => n * 2)).toEqual([2, 4])
  })

  it('propagates a worker rejection', async () => {
    await expect(
      mapPool([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom')
        return n
      }),
    ).rejects.toThrow('boom')
  })
})
