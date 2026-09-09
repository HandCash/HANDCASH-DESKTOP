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

  it('keeps both tips when the live UTXO set still lists both outpoints', () => {
    const a = tip(`${'bb'.repeat(32)}.0`)
    const b = tip(`${'cc'.repeat(32)}.1`)
    const live = new Set([a.outpoint, b.outpoint])

    const kept = dedupeByOrigin([a, b], () => 1, live)

    expect(kept.map((c) => c.outpoint).sort()).toEqual(
      [a.outpoint, b.outpoint].sort(),
    )
  })

  it('keeps both tips when live cache is unknown (null) after a send', () => {
    // finishSend clears cachedLiveOneSats; without this fallback, same-origin
    // siblings collapse and one fox disappears from Collect.
    const a = tip(`${'bb'.repeat(32)}.0`)
    const b = tip(`${'cc'.repeat(32)}.1`)

    const kept = dedupeByOrigin([a, b], () => 1, null)

    expect(kept.map((c) => c.outpoint).sort()).toEqual(
      [a.outpoint, b.outpoint].sort(),
    )
  })

  it('still collapses to the newer tip when an empty live set is known', () => {
    const stale = tip(`${'bb'.repeat(32)}.0`, { proven: true })
    const fresh = tip(`${'cc'.repeat(32)}.0`)
    const seenAt = new Map([
      [stale.outpoint, 1_000],
      [fresh.outpoint, 2_000],
    ])

    const kept = dedupeByOrigin(
      [stale, fresh],
      (op) => seenAt.get(op) ?? 0,
      new Set(),
    )

    expect(kept).toHaveLength(1)
    expect(kept[0]!.outpoint).toBe(fresh.outpoint)
  })
})
