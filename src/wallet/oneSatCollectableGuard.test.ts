import { describe, expect, it } from 'vitest'
import {
  applyCollectableRemittance,
  collectableKeySet,
  collectableLatchHolds,
  isLatchedCollectable,
  keepCollectablesOutOfTokenRoute,
  skipTokenImportForBasketHeld,
  wireCollectableOutpoint,
} from './oneSatCollectableGuard'

const ORIGIN = `${'aa'.repeat(32)}_0`
const OP = `${'bb'.repeat(32)}.0`
const OTHER = `${'cc'.repeat(32)}.0`

describe('oneSatCollectableGuard', () => {
  it('normalizes underscore outpoints to dotted form', () => {
    expect(wireCollectableOutpoint(`${'bb'.repeat(32)}_0`)).toBe(OP)
    expect(collectableKeySet([`${'bb'.repeat(32)}_0`]).has(OP)).toBe(true)
    expect(isLatchedCollectable(OP, collectableKeySet([`${'bb'.repeat(32)}_0`]))).toBe(
      true,
    )
  })

  it('rescues a known collectable out of the BSV-21 / NFT bucket', () => {
    const remittance = new Map([
      [OP, { outpoint: OP, origin: ORIGIN, name: 'Pixel Fox' }],
    ])
    const result = keepCollectablesOutOfTokenRoute(
      [],
      [{ outpoint: OP, tokenId: ORIGIN, amt: '1' }],
      [OP],
      remittance,
    )

    expect(result.tokenTips).toEqual([])
    expect(result.rescued).toEqual([OP])
    expect(result.oneSats).toEqual([
      expect.objectContaining({ outpoint: OP, origin: ORIGIN, name: 'Pixel Fox' }),
    ])
  })

  it('does not duplicate a collectable already in oneSats', () => {
    const result = keepCollectablesOutOfTokenRoute(
      [{ outpoint: OP, origin: ORIGIN, name: 'Pixel Fox' }],
      [{ outpoint: `${'bb'.repeat(32)}_0` }],
      [OP],
    )

    expect(result.tokenTips).toEqual([])
    expect(result.oneSats).toHaveLength(1)
    expect(result.oneSats[0]!.name).toBe('Pixel Fox')
  })

  it('leaves unknown token tips alone', () => {
    const tip = { outpoint: OTHER, tokenId: 'tok', amt: '10' }
    const result = keepCollectablesOutOfTokenRoute(
      [{ outpoint: OP, origin: ORIGIN }],
      [tip],
      [OP],
    )
    expect(result.tokenTips).toEqual([tip])
    expect(result.rescued).toEqual([])
    expect(result.oneSats).toHaveLength(1)
  })

  it('skips token import when the tip is already in basket 1sat', () => {
    const result = skipTokenImportForBasketHeld(
      [{ outpoint: OP }, { outpoint: OTHER }],
      [`${'bb'.repeat(32)}_0`],
    )
    expect(result.skipped).toEqual([OP])
    expect(result.tokenTips.map((t) => t.outpoint)).toEqual([OTHER])
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
