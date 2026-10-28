import { beforeEach, describe, expect, it } from 'vitest'
import { setLabEnabled } from '../labs'
import { ARC_USDC_ERC20 } from './chain'
import { planFractionalize, planRedeem } from './fractionalize'

const ARC_MAIN = 5042
const ETH_MAIN = 1
const DEPOSIT = {
  chainId: ARC_MAIN,
  txHash: `0x${'ab'.repeat(32)}`,
  logIndex: 0,
  atoms: '1000000',
}

describe('Arc USDC fractionalize (lab)', () => {
  beforeEach(() => {
    setLabEnabled('arcUsdc', false)
  })

  it('refuses when the lab flag is off', () => {
    expect(() => planFractionalize(DEPOSIT)).toThrow(/ARC_USDC_LAB/)
  })

  it('plans a fractionalize only for Arc mainnet USDC', () => {
    setLabEnabled('arcUsdc', true)
    const plan = planFractionalize(DEPOSIT)
    expect(plan.network).toBe('arc-mainnet')
    expect(plan.tokenAddress).toBe(ARC_USDC_ERC20)
    expect(plan.bsvSymbol).toBe('USDC')
    expect(plan.status).toBe('planned')
  })

  it('refuses Ethereum (and any non-Arc) chainId', () => {
    setLabEnabled('arcUsdc', true)
    expect(() => planFractionalize({ ...DEPOSIT, chainId: ETH_MAIN })).toThrow(/ARC_USDC_CHAIN/)
  })

  it('refuses a non-Arc USDC token address on Arc', () => {
    setLabEnabled('arcUsdc', true)
    expect(() =>
      planFractionalize({
        ...DEPOSIT,
        tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      }),
    ).toThrow(/ARC_USDC_TOKEN/)
  })

  it('plans redeem only to an Arc payout when lab is on', () => {
    setLabEnabled('arcUsdc', true)
    const plan = planRedeem({
      chainId: ARC_MAIN,
      atoms: '500000',
      to: '0x1111111111111111111111111111111111111111',
    })
    expect(plan.network).toBe('arc-mainnet')
    expect(plan.status).toBe('planned')
  })
})
