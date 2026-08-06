import { describe, expect, it } from 'vitest'
import { dedupeByOrigin } from './collectables'
import type { Collectable } from './collectables'

const ORIGIN = `${'aa'.repeat(32)}_0`

function tip(outpoint: string, over: Partial<Collectable> = {}): Collectable {
  return {
    outpoint,
    origin: ORIGIN,
    name: 'Pixel Foxes',
    imageUrl: 'https://example.test/img',
    satoshis: 1,
    traits: [],
    extras: [],
    proven: false,
    authenticity: 'unproven',
    ...over,
  }
}

describe('dedupeByOrigin', () => {
  it('keeps the tip seen most recently when two share an origin', () => {
    const stale = tip(`${'bb'.repeat(32)}.0`, { proven: true, app: 'Market' })
    const fresh = tip(`${'cc'.repeat(32)}.0`, { name: ORIGIN.slice(0, 6) })
    const seenAt = new Map([
      [stale.outpoint, 1_000],
      [fresh.outpoint, 2_000],
    ])

    const kept = dedupeByOrigin([stale, fresh], (op) => seenAt.get(op) ?? 0)

    // The stale row looks richer — proven, named, with an app — but it is the
    // residue of a transfer that already moved on.
    expect(kept).toHaveLength(1)
    expect(kept[0]!.outpoint).toBe(fresh.outpoint)
  })

  it('falls back to metadata when both were first seen in the same pass', () => {
    const bare = tip(`${'bb'.repeat(32)}.1`, { name: 'aaaaaa', app: undefined })
    const rich = tip(`${'cc'.repeat(32)}.0`, { proven: true, app: 'Market' })

    const kept = dedupeByOrigin([bare, rich], () => 5_000)

    expect(kept).toHaveLength(1)
    expect(kept[0]!.outpoint).toBe(rich.outpoint)
  })

  it('leaves distinct origins alone and preserves their order', () => {
    const a = tip(`${'bb'.repeat(32)}.0`, { origin: `${'11'.repeat(32)}_0` })
    const b = tip(`${'cc'.repeat(32)}.0`, { origin: `${'22'.repeat(32)}_0` })

    expect(dedupeByOrigin([a, b]).map((c) => c.outpoint)).toEqual([
      a.outpoint,
      b.outpoint,
    ])
  })
})
