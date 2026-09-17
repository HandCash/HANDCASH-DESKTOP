import { describe, expect, it } from 'vitest'
import { itemHistory } from './itemHistory'
import type { Collectable } from './collectables'

describe('itemHistory', () => {
  it('lists newest first: held tip, then mint at origin', () => {
    const origin = `${'aa'.repeat(32)}_0`
    const tip = `${'bb'.repeat(32)}.1`
    const item: Collectable = {
      outpoint: tip,
      origin,
      name: 'Fox #1',
      imageUrl: '',
      satoshis: 1,
      traits: [],
      extras: [],
      proven: true,
      authenticity: 'brc150',
    }
    const events = itemHistory(item)
    expect(events[0]?.kind).toBe('hold')
    expect(events[0]?.mark).toBe('receive')
    expect(events.at(-1)?.kind).toBe('mint')
    expect(events.at(-1)?.title).toBe('Minted')
  })

  it('does not add held-in-wallet when a receive already covers the tip', () => {
    const origin = `${'aa'.repeat(32)}_0`
    const tip = `${'bb'.repeat(32)}.1`
    const item: Collectable = {
      outpoint: tip,
      origin,
      name: 'Fox #1',
      imageUrl: '',
      satoshis: 1,
      traits: [],
      extras: [],
      proven: true,
      authenticity: 'brc150',
    }
    const events = itemHistory(item, [
      {
        id: 'recv-1',
        origin: 'handcash',
        kind: 'earned',
        sats: 1,
        at: 1,
        method: 'receive-collectable',
        item: { origin, outpoint: tip, name: 'Collectable' },
      },
    ])
    expect(events.map((event) => event.kind)).toEqual(['activity', 'mint'])
    expect(events[0]?.title).toBe('Received Fox #1')
    expect(events.some((event) => event.kind === 'hold')).toBe(false)
  })
})
