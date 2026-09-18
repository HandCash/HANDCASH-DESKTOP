import { describe, expect, it } from 'vitest'
import { pickReclaimSeals } from './reclaimSealBatch'

describe('pickReclaimSeals', () => {
  it('always includes priority outpoints before rotating the rest', () => {
    const records = Array.from({ length: 5 }, (_, i) => ({
      outpoint: `n${i}`,
      satoshis: i * 10,
    }))
    const first = pickReclaimSeals(records, {
      max: 3,
      cursor: 0,
      priorityOutpoints: new Set(['n1']),
    })
    expect(first.picked.map((row) => row.outpoint)).toEqual(['n1', 'n4', 'n3'])
    const second = pickReclaimSeals(records, {
      max: 3,
      cursor: first.nextCursor,
      priorityOutpoints: new Set(['n1']),
    })
    expect(second.picked.map((row) => row.outpoint)).toContain('n1')
    expect(second.picked.map((row) => row.outpoint)).toContain('n2')
    expect(second.picked.map((row) => row.outpoint)).toContain('n0')
  })

  it('rotates past the cap so later records are not permanently skipped', () => {
    const records = Array.from({ length: 4 }, (_, i) => ({
      outpoint: `x${i}`,
      satoshis: 1,
    }))
    const a = pickReclaimSeals(records, { max: 2, cursor: 0 })
    const b = pickReclaimSeals(records, { max: 2, cursor: a.nextCursor })
    const seen = new Set([...a.picked, ...b.picked].map((row) => row.outpoint))
    expect(seen.size).toBe(4)
  })
})
