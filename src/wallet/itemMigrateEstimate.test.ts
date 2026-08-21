import { describe, expect, test } from 'vitest'
import { estimateItemMigrateCost, phraseItemUnspentOffset } from './phraseSweep'
import { MAX_ITEMS_PER_MIGRATE_TX } from './itemMigrateBundle'

/**
 * The preview quotes this number before the user spends anything, so it has to
 * track the transaction shape the migrate path actually builds.
 */
describe('estimateItemMigrateCost', () => {
  test('an empty collection costs nothing', () => {
    expect(estimateItemMigrateCost({ itemCount: 0 })).toEqual({
      transactions: 0,
      feeSats: 0,
    })
  })

  test('a partial batch still needs one whole transaction', () => {
    const one = estimateItemMigrateCost({ itemCount: 1, itemsPerTx: 25 })
    const full = estimateItemMigrateCost({ itemCount: 25, itemsPerTx: 25 })
    expect(one.transactions).toBe(1)
    expect(one.feeSats).toBe(38)
    expect(one.feeSats).toBeLessThan(full.feeSats)
  })

  test('transaction count divides the collection by the bundle size', () => {
    expect(estimateItemMigrateCost({ itemCount: 800_000, itemsPerTx: 25 })).toEqual({
      transactions: 32_000,
      feeSats: 32_000 * 475,
    })
  })

  test('bundling more tips per transaction lowers the total fee', () => {
    const small = estimateItemMigrateCost({ itemCount: 1_000, itemsPerTx: 1 })
    const large = estimateItemMigrateCost({ itemCount: 1_000, itemsPerTx: 25 })
    expect(large.transactions).toBeLessThan(small.transactions)
    expect(large.feeSats).toBeLessThan(small.feeSats)
  })

  test('itemsPerTx is clamped to the migrate bundle ceiling', () => {
    expect(
      estimateItemMigrateCost({ itemCount: 1_000, itemsPerTx: MAX_ITEMS_PER_MIGRATE_TX * 10 }),
    ).toEqual(
      estimateItemMigrateCost({ itemCount: 1_000, itemsPerTx: MAX_ITEMS_PER_MIGRATE_TX }),
    )
  })

  test('a zero fee rate quotes transactions but no fee', () => {
    expect(
      estimateItemMigrateCost({ itemCount: 100, itemsPerTx: 25, feeRateSatPerKb: 0 }),
    ).toEqual({ transactions: 4, feeSats: 0 })
  })
})

describe('phraseItemUnspentOffset', () => {
  test('successful moves do not skip the next rows after they leave the unspent list', () => {
    expect(phraseItemUnspentOffset({ offset: 15, moved: 15 })).toBe(0)
    expect(phraseItemUnspentOffset({ offset: 50, moved: 50 })).toBe(0)
  })

  test('failed or skipped rows remain ahead of the next item', () => {
    // The cursor scanned 50 rows: 40 moved away and 10 remain visible.
    expect(phraseItemUnspentOffset({ offset: 50, moved: 40 })).toBe(10)
  })

  test('malformed legacy values fail closed at the start of the list', () => {
    expect(phraseItemUnspentOffset({ offset: -1, moved: 10 })).toBe(0)
    expect(phraseItemUnspentOffset({ offset: 10, moved: 20 })).toBe(0)
  })
})
