import { describe, expect, it } from 'vitest'
import {
  applyCollectableRemittance,
  collectableKeySet,
  collectableLatchHolds,
  isLatchedCollectable,
  wireCollectableOutpoint,
} from './oneSatCollectableGuard'

const ORIGIN = `${'aa'.repeat(32)}_0`
const OP = `${'bb'.repeat(32)}.0`

describe('oneSatCollectableGuard', () => {
  it('normalizes underscore outpoints to dotted form', () => {
    expect(wireCollectableOutpoint(`${'bb'.repeat(32)}_0`)).toBe(OP)
    expect(collectableKeySet([`${'bb'.repeat(32)}_0`]).has(OP)).toBe(true)
    expect(isLatchedCollectable(OP, collectableKeySet([`${'bb'.repeat(32)}_0`]))).toBe(
      true,
    )
  })

  it('preserves remittance so heal/reimport does not paint a generic NFT', () => {
    const item = applyCollectableRemittance(
      { outpoint: OP, origin: `${'bb'.repeat(32)}_0`, name: 'Collectable' },
      { outpoint: OP, origin: ORIGIN, name: 'Pixel Fox', app: 'Market' },
    )
    expect(item).toEqual({
      outpoint: OP,
      origin: ORIGIN,
      name: 'Pixel Fox',
      app: 'Market',
    })
  })

  it('holds the collectable latch only when remittance names a collection', () => {
    expect(collectableLatchHolds({ collectionId: ORIGIN })).toBe(true)
    expect(collectableLatchHolds({ collectionId: '  ' })).toBe(false)
    expect(collectableLatchHolds({ collectionId: undefined })).toBe(false)
    expect(collectableLatchHolds(undefined)).toBe(false)
  })
})
