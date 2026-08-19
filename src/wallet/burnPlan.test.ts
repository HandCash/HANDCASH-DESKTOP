import { describe, expect, it } from 'vitest'
import type { Bsv21Utxo } from './bsv21'
import {
  burnRecoveryOutputSatoshis,
  planBsv21Burn,
  planOneSatBurn,
} from './burnPlan'

const TOKEN_ID = `${'ab'.repeat(32)}_0`
const OWN_P2PKH = `76a914${'11'.repeat(20)}88ac`
const COSIGNED = `76a914${'11'.repeat(20)}88ad21${`02${'22'.repeat(32)}`}ac`
const COVENANT = '51'.repeat(50)

function tokenTip(
  outpoint: string,
  amt: string,
  lockingScript = OWN_P2PKH,
): Bsv21Utxo {
  return {
    outpoint,
    tokenId: TOKEN_ID,
    amt,
    op: 'transfer',
    dec: 0,
    satoshis: 1,
    lockingScript,
  }
}

describe('burn planners', () => {
  it('plans a canonical token burn, change and physical-sat recovery', () => {
    const plan = planBsv21Burn({
      tokenId: TOKEN_ID,
      amount: '50',
      tips: [
        tokenTip(`${'01'.repeat(32)}.0`, '30'),
        tokenTip(`${'02'.repeat(32)}.0`, '40'),
        tokenTip(`${'03'.repeat(32)}.0`, '20'),
      ],
      ownsLockingScript: () => true,
    })
    expect(plan.path).toBe('burnBsv21')
    if (plan.path !== 'burnBsv21') return
    expect(plan.burnAmount).toBe(50n)
    expect(plan.selectedAmount).toBe(70n)
    expect(plan.changeAmount).toBe(20n)
    expect(plan.inputs).toHaveLength(2)
    // Two 1-sat inputs fund the 1-sat burn and 1-sat token-change outputs.
    expect(plan.recoverSatoshis).toBe(0)
  })

  it('recovers surplus physical token-tip sats', () => {
    const tips = [
      { ...tokenTip(`${'04'.repeat(32)}.0`, '10'), satoshis: 3 },
    ]
    const plan = planBsv21Burn({
      tokenId: TOKEN_ID,
      amount: '10',
      tips,
      ownsLockingScript: () => true,
    })
    expect(plan).toMatchObject({
      path: 'burnBsv21',
      changeAmount: 0n,
      recoverSatoshis: 2,
    })
  })

  it('refuses mixed, covenant and unknown token locks', () => {
    expect(
      planBsv21Burn({
        tokenId: TOKEN_ID,
        amount: '1',
        tips: [
          tokenTip(`${'05'.repeat(32)}.0`, '1'),
          tokenTip(`${'06'.repeat(32)}.0`, '1', COSIGNED),
        ],
        ownsLockingScript: () => true,
      }),
    ).toMatchObject({ path: 'refuse', reason: 'mixed_tips' })
    expect(
      planBsv21Burn({
        tokenId: TOKEN_ID,
        amount: '1',
        tips: [tokenTip(`${'07'.repeat(32)}.0`, '1', COVENANT)],
        ownsLockingScript: () => true,
      }),
    ).toMatchObject({ path: 'refuse', reason: 'covenant_locked' })
    expect(
      planBsv21Burn({
        tokenId: TOKEN_ID,
        amount: '1',
        tips: [tokenTip(`${'08'.repeat(32)}.0`, '1', '51')],
        ownsLockingScript: () => true,
      }),
    ).toMatchObject({ path: 'refuse', reason: 'unknown_lock' })
  })

  it('never burns sibling deploy ids under one burn record', () => {
    expect(
      planBsv21Burn({
        tokenId: TOKEN_ID,
        amount: '2',
        tips: [
          tokenTip(`${'18'.repeat(32)}.0`, '1'),
          {
            ...tokenTip(`${'19'.repeat(32)}.0`, '1'),
            tokenId: `${'cd'.repeat(32)}_0`,
          },
        ],
        ownsLockingScript: () => true,
      }),
    ).toMatchObject({ path: 'refuse', reason: 'multiple_token_ids' })
  })

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
