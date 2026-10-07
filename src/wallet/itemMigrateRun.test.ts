import { describe, expect, it } from 'vitest'
import {
  ITEM_MIGRATE_STOP_MESSAGES,
  classifyItemMigrateFault,
  itemMigrateStopPauses,
  refusedOverFunding,
  type ItemMigrateStop,
} from './itemMigrateRun'

const tip = `${'a'.repeat(64)}.1`
const group = [{ outpoint: tip }]
const refusal = (reason: string, dead: string[] = []) =>
  Object.assign(new Error(reason), { code: 'INPUTS_UNVERIFIED', reason, dead })

describe('refusedOverFunding', () => {
  it('blames the wallet’s fee coin only when the bundle’s own tips are not the dead inputs', () => {
    expect(refusedOverFunding(refusal('still-dead'), group)).toBe(true)
    expect(refusedOverFunding(refusal('input-spent', [`${'b'.repeat(64)}.0`]), group)).toBe(true)
    expect(refusedOverFunding(refusal('input-spent', [`${'A'.repeat(64)}_1`]), group)).toBe(false)
    expect(refusedOverFunding(refusal('input-spent'), group)).toBe(false)
    expect(refusedOverFunding(new Error('Insufficient funds'), group)).toBe(false)
  })
})

describe('classifyItemMigrateFault', () => {
  it('keeps the abandoned work so the run can wait for what it did', async () => {
    const late = Promise.resolve('done')
    const fault = classifyItemMigrateFault(Object.assign(new Error('stopped'), { code: 'SPEND_REGION_ABANDONED', late }), group)
    expect(fault.kind).toBe('abandoned')
    await expect((fault as { late: Promise<unknown> }).late).resolves.toBe('done')
  })

  it('names the job holding a busy wallet', () => {
    const busy = Object.assign(new Error('Wallet is busy'), {
      name: 'WalletCoordinatorAcquireTimeoutError',
      coordinatorSummary: 'active: recompose',
    })
    expect(classifyItemMigrateFault(busy, group)).toMatchObject({ kind: 'busy', held: 'active: recompose' })
  })

  it('separates wallet and network faults from a rejected bundle', () => {
    const kind = (err: unknown) => classifyItemMigrateFault(err, group).kind
    expect(kind(new Error('Insufficient funds in the available inputs (12 more satoshis are needed)'))).toBe('funds')
    expect(kind(refusal('still-dead'))).toBe('stale-funding')
    expect(kind(new Error('WALLET_LOCKED: unlock this wallet'))).toBe('locked')
    expect(kind(new TypeError('Failed to fetch'))).toBe('network')
    expect(kind(new Error('ARC status 503'))).toBe('network')
    expect(kind(new Error('Script evaluation failed'))).toBe('rejected')
    // The bundle's own tip is dead: that is about the tips, worth halving.
    expect(kind(refusal('input-spent', [tip]))).toBe('rejected')
  })
})

describe('item migrate stops', () => {
  it('pauses only on stops a short wait clears', () => {
    const all = Object.keys(ITEM_MIGRATE_STOP_MESSAGES) as ItemMigrateStop[]
    expect(all.filter(itemMigrateStopPauses).sort()).toEqual(['propagating', 'stale-funding'])
    expect(itemMigrateStopPauses(null)).toBe(false)
  })
})
