import { describe, expect, it } from 'vitest'
import {
  chooseCollectableSendBatch,
  collectableBatchOutputOutpoint,
  collectableSendBatchRefusal,
  MAX_ITEMS_PER_ONE_SAT_TX,
  normalizeCollectableBatchOutpoints,
} from './collectableBatch'

/** Distinct valid outpoints for a synthetic selection. */
function selection(count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `${i.toString(16).padStart(64, '0')}.0`,
  )
}

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

describe('collectable send batch ceiling', () => {
  it('refuses an empty selection', () => {
    expect(chooseCollectableSendBatch([])).toEqual({
      kind: 'refuse',
      reason: 'empty',
    })
    expect(chooseCollectableSendBatch(['   '])).toEqual({
      kind: 'refuse',
      reason: 'empty',
    })
  })

  it('routes a de-duplicated single tip to the single-send path', () => {
    const [only] = selection(1)
    expect(chooseCollectableSendBatch([only!, only!])).toEqual({
      kind: 'single',
      outpoint: only,
    })
  })

  it('keeps a selection at the ceiling atomic', () => {
    const batch = chooseCollectableSendBatch(selection(MAX_ITEMS_PER_ONE_SAT_TX))
    expect(batch.kind).toBe('atomic')
    expect(batch.kind === 'atomic' && batch.outpoints).toHaveLength(
      MAX_ITEMS_PER_ONE_SAT_TX,
    )
  })

  it('refuses above the ceiling instead of building a stalling transaction', () => {
    const batch = chooseCollectableSendBatch(selection(700))
    expect(batch).toEqual({
      kind: 'refuse',
      reason: 'tooMany',
      count: 700,
      max: MAX_ITEMS_PER_ONE_SAT_TX,
    })
    expect(
      collectableSendBatchRefusal(
        batch as Extract<typeof batch, { kind: 'refuse' }>,
      ),
    ).toContain(String(MAX_ITEMS_PER_ONE_SAT_TX))
  })
})
