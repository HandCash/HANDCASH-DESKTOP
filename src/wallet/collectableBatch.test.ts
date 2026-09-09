import { describe, expect, it } from 'vitest'
import {
  collectableBatchOutputOutpoint,
  normalizeCollectableBatchOutpoints,
} from './collectableBatch'

describe('collectable batch transaction ordering', () => {
  it('normalizes, de-duplicates, and preserves selection order', () => {
    const a = `${'A'.repeat(64)}_2`
    const b = `${'b'.repeat(64)}.7`

    expect(normalizeCollectableBatchOutpoints([a, b, a])).toEqual([
      `${'a'.repeat(64)}.2`,
      b,
    ])
  })

  it('maps each metadata output to its deterministic transaction vout', () => {
    const txid = 'C'.repeat(64)

    expect(collectableBatchOutputOutpoint(txid, 0)).toBe(
      `${'c'.repeat(64)}.0`,
    )
    expect(collectableBatchOutputOutpoint(txid, 3)).toBe(
      `${'c'.repeat(64)}.3`,
    )
  })
})
