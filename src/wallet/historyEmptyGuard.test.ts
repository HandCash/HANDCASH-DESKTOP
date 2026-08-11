import { describe, expect, it } from 'vitest'
import {
  allowEmptyLocalHistoryPull,
  decideEmptyHistoryOverwrite,
  decideHistoryPush,
  decideThinHistoryOverwrite,
  MIN_REMOTE_BYTES_TO_PROTECT,
  SPENDABLE_COMPARE_MARGIN_SATS,
} from './historyEmptyGuard'

describe('decideEmptyHistoryOverwrite (isolated edge case)', () => {
  it('refuses empty local over a protected remote', () => {
    const d = decideEmptyHistoryOverwrite({
      remoteExists: true,
      remoteBytes: 10_000,
      localLooksEmpty: true,
    })
    expect(d.refusePush).toBe(true)
    expect(d.reason).toMatch(/refuse empty/i)
  })

  it('allows push when local has history', () => {
    const d = decideEmptyHistoryOverwrite({
      remoteExists: true,
      remoteBytes: 10_000,
      localLooksEmpty: false,
    })
    expect(d.refusePush).toBe(false)
  })

  it('allows first upload when remote is missing', () => {
    const d = decideEmptyHistoryOverwrite({
      remoteExists: false,
      remoteBytes: null,
      localLooksEmpty: true,
    })
    expect(d.refusePush).toBe(false)
  })

  it('treats tiny remote stubs as unprotected', () => {
    const d = decideEmptyHistoryOverwrite({
      remoteExists: true,
      remoteBytes: MIN_REMOTE_BYTES_TO_PROTECT - 1,
      localLooksEmpty: true,
    })
    expect(d.refusePush).toBe(false)
  })

  it('allows forced manual overwrite', () => {
    const d = decideEmptyHistoryOverwrite({
      remoteExists: true,
      remoteBytes: 10_000,
      localLooksEmpty: true,
      force: true,
    })
    expect(d.refusePush).toBe(false)
  })
})

describe('decideThinHistoryOverwrite (UTXO only dispensed when spent)', () => {
  it('refuses thinner local over richer remote without new actions', () => {
    const d = decideThinHistoryOverwrite({
      localSpendableSats: 91_024,
      localActionCount: 32,
      remoteSpendableSats: 1_127_770,
      remoteActionCount: 40,
      highWaterSpendableSats: null,
      highWaterActionCount: null,
    })
    expect(d.refusePush).toBe(true)
    expect(d.reason).toMatch(/richer remote/i)
  })

  it('allows spend-down when action count rises', () => {
    const d = decideThinHistoryOverwrite({
      localSpendableSats: 100_000,
      localActionCount: 41,
      remoteSpendableSats: 1_127_770,
      remoteActionCount: 40,
      highWaterSpendableSats: 1_127_770,
      highWaterActionCount: 40,
    })
    expect(d.refusePush).toBe(false)
  })

  it('refuses drop below high-water without new spends', () => {
    const d = decideThinHistoryOverwrite({
      localSpendableSats: 91_024,
      localActionCount: 32,
      remoteSpendableSats: null,
      remoteActionCount: null,
      highWaterSpendableSats: 1_127_770,
      highWaterActionCount: 40,
    })
    expect(d.refusePush).toBe(true)
    expect(d.reason).toMatch(/high-water/i)
  })

  it('allows within margin of richer baseline', () => {
    const rich = 100_000
    const d = decideThinHistoryOverwrite({
      localSpendableSats: rich - SPENDABLE_COMPARE_MARGIN_SATS,
      localActionCount: 10,
      remoteSpendableSats: rich,
      remoteActionCount: 10,
      highWaterSpendableSats: null,
      highWaterActionCount: null,
    })
    expect(d.refusePush).toBe(false)
  })

  it('allows forced manual overwrite of thin local', () => {
    const d = decideThinHistoryOverwrite({
      localSpendableSats: 1,
      localActionCount: 1,
      remoteSpendableSats: 1_000_000,
      remoteActionCount: 50,
      highWaterSpendableSats: 1_000_000,
      highWaterActionCount: 50,
      force: true,
    })
    expect(d.refusePush).toBe(false)
  })
})

describe('decideHistoryPush', () => {
  it('prefers empty refuse over thin', () => {
    const d = decideHistoryPush({
      remoteExists: true,
      remoteBytes: 10_000,
      localLooksEmpty: true,
      localSpendableSats: 0,
      localActionCount: 0,
      remoteSpendableSats: 1_000_000,
      remoteActionCount: 10,
      highWaterSpendableSats: null,
      highWaterActionCount: null,
    })
    expect(d.reason).toMatch(/empty/i)
  })
})

describe('allowEmptyLocalHistoryPull', () => {
  it('allows recovery paths only', () => {
    expect(allowEmptyLocalHistoryPull('unlock')).toBe(true)
    expect(allowEmptyLocalHistoryPull('restore')).toBe(true)
    expect(allowEmptyLocalHistoryPull('recompose')).toBe(true)
    expect(allowEmptyLocalHistoryPull('createAction')).toBe(false)
    expect(allowEmptyLocalHistoryPull('send')).toBe(false)
  })
})
