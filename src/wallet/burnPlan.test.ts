import { describe, expect, it } from 'vitest'
import {
  burnRecoveryOutputSatoshis,
  planOneSatBurn,
} from './burnPlan'

const OWN_P2PKH = `76a914${'11'.repeat(20)}88ac`
const COVENANT = '51'.repeat(50)

describe('burn planners', () => {
  it('packs selected 1Sat tips into one value-conserving recovery output', () => {
    const plan = planOneSatBurn({
      tips: [
        { outpoint: `${'09'.repeat(32)}.0`, satoshis: 1, lockingScript: OWN_P2PKH },
        { outpoint: `${'10'.repeat(32)}.0`, satoshis: 1, lockingScript: OWN_P2PKH },
      ],
      ownsLockingScript: () => true,
    })
    expect(plan).toMatchObject({
      path: 'burnOneSat',
      recoverSatoshis: 2,
    })
  })

  it('tops a single item up to a multi-sat output so its origin ends', () => {
    const plan = planOneSatBurn({
      tips: [
        { outpoint: `${'20'.repeat(32)}.0`, satoshis: 1, lockingScript: OWN_P2PKH },
      ],
      ownsLockingScript: () => true,
    })
    expect(plan.path).toBe('burnOneSat')
    if (plan.path !== 'burnOneSat') return
    expect(plan.recoverSatoshis).toBe(1)
    expect(burnRecoveryOutputSatoshis(plan)).toBe(2)
  })

  it('refuses non-one-sat, covenant and non-owned collectable inputs', () => {
    expect(
      planOneSatBurn({
        tips: [{ outpoint: 'a.0', satoshis: 2, lockingScript: OWN_P2PKH }],
        ownsLockingScript: () => true,
      }),
    ).toMatchObject({ path: 'refuse', reason: 'not_one_sat' })
    expect(
      planOneSatBurn({
        tips: [{ outpoint: 'a.0', satoshis: 1, lockingScript: COVENANT }],
        ownsLockingScript: () => true,
      }),
    ).toMatchObject({ path: 'refuse', reason: 'covenant_locked' })
    expect(
      planOneSatBurn({
        tips: [{ outpoint: 'a.0', satoshis: 1, lockingScript: OWN_P2PKH }],
        ownsLockingScript: () => false,
      }),
    ).toMatchObject({ path: 'refuse', reason: 'not_owned' })
  })
})
