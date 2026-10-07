import { describe, expect, test } from 'vitest'
import { estimateItemMigrateCost } from './phraseSweep'
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
