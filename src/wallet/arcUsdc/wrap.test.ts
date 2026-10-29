import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value)
  },
  removeItem: (key: string) => {
    store.delete(key)
  },
})

vi.mock('../accountLocalKeys', () => ({
  accountLocalKey: (key: string) => key,
}))

import { setLabEnabled } from '../labs'
import { ARC_USDC_ERC20 } from './chain'
import {
  checkArcReceiptProof,
  arcDepositOutpoint,
  arcReserveHex,
  padAddressTopic,
  ERC20_TRANSFER_TOPIC,
} from './backing'
import {
  ArcWrapRefusalError,
  depositClaimId,
  encodeTransferLogData,
  executeFractionalize,
  executeRedeem,
  getWrapAssetId,
  getWrapSpendable,
  listWrapClaims,
  listWrapRedeems,
  resetWrapStoreForTest,
  setWrapBurnForTest,
  setWrapMintForTest,
  setWrapPayoutForTest,
  setWrapReserveForTest,
  setWrapVerifyForTest,
  sightingFromReceiptLog,
  transferTopic0,
  type ArcUsdcDeposit,
  type MintWrapUnits,
  type VerifyArcDeposit,
} from './wrap'

const ARC_MAIN = 5042
const TX_A = `0x${'ab'.repeat(32)}`
const TX_B = `0x${'cd'.repeat(32)}`
const PAYOUT_TX = `0x${'11'.repeat(32)}`
const BURN_TX = '22'.repeat(32)
const RESERVE = '0x1111111111111111111111111111111111111111'
const ASSET = 'aa'.repeat(20)

const DEPOSIT_A: ArcUsdcDeposit = {
  chainId: ARC_MAIN,
  txHash: TX_A,
  logIndex: 0,
  atoms: '1000000',
}

const DEPOSIT_B: ArcUsdcDeposit = {
  chainId: ARC_MAIN,
  txHash: TX_B,
  logIndex: 1,
  atoms: '2500000',
}

function logFor(deposit: ArcUsdcDeposit, to = RESERVE) {
  return {
    address: ARC_USDC_ERC20,
    topics: [
      ERC20_TRANSFER_TOPIC,
      padAddressTopic('0x2222222222222222222222222222222222222222'),
      padAddressTopic(to),
    ],
    data: encodeTransferLogData(BigInt(deposit.atoms)),
  }
}

const okVerify: VerifyArcDeposit = async (d) => ({
  atoms: d.atoms,
  to: RESERVE,
  tokenAddress: ARC_USDC_ERC20,
  log: logFor(d),
})

function labMint(): MintWrapUnits {
  let spendable = 0n
  let assetId: string | null = null
  let n = 0
  return async (args) => {
    spendable += BigInt(args.atoms)
    if (!assetId) assetId = ASSET
    n += 1
    return {
      assetId,
      mintTxid: `${'33'.repeat(31)}${n.toString(16).padStart(2, '0')}`,
      spendable: spendable.toString(),
    }
  }
}

describe('Arc USDC wrap → BNT link (lab execute)', () => {
  beforeEach(async () => {
    store.clear()
    const { durableForgetCached } = await import('../durableStorage')
    durableForgetCached()
    setLabEnabled('arcUsdc', false)
    setWrapVerifyForTest(null)
    setWrapPayoutForTest(null)
    setWrapMintForTest(null)
    setWrapBurnForTest(null)
    setWrapReserveForTest(RESERVE)
    resetWrapStoreForTest()
  })

  it('keeps Transfer topic0 aligned with keccak', () => {
    expect(transferTopic0()).toBe(ERC20_TRANSFER_TOPIC)
  })

  it('checks an Arc receipt proof against reserve and deposit outpoint', () => {
    const deposit = arcDepositOutpoint(TX_A, 0)
    const proof = {
      kind: 'arc-receipt' as const,
      txHash: TX_A,
      logIndex: 0,
      status: '0x1',
      log: logFor(DEPOSIT_A),
    }
    expect(checkArcReceiptProof(arcReserveHex(RESERVE), proof, deposit, 1_000_000n)).toEqual({
      ok: true,
    })
    expect(
      checkArcReceiptProof(arcReserveHex(RESERVE), proof, deposit, 1_000_001n).ok,
    ).toBe(false)
  })

  it('refuses wrap when the lab flag is off', async () => {
    await expect(executeFractionalize(DEPOSIT_A, { verify: okVerify, mint: labMint() })).rejects.toMatchObject({
      reason: 'lab-off',
    })
  })

  it('mints BNT-backed units from a verified deposit', async () => {
    setLabEnabled('arcUsdc', true)
    setWrapVerifyForTest(okVerify)
    setWrapMintForTest(labMint())
    const wrapped = await executeFractionalize(DEPOSIT_A)
    expect(wrapped.status).toBe('wrapped')
    expect(wrapped.assetId).toBe(ASSET)
    expect(wrapped.claim.id).toBe(depositClaimId('arc-mainnet', TX_A, 0))
    expect(wrapped.spendable).toBe('1000000')
    expect(getWrapSpendable()).toBe('1000000')
    expect(getWrapAssetId()).toBe(ASSET)
    expect(listWrapClaims()).toHaveLength(1)
  })

  it('refuses a second wrap of the same deposit', async () => {
    setLabEnabled('arcUsdc', true)
    setWrapVerifyForTest(okVerify)
    setWrapMintForTest(labMint())
    await executeFractionalize(DEPOSIT_A)
    await expect(executeFractionalize(DEPOSIT_A)).rejects.toBeInstanceOf(ArcWrapRefusalError)
    await expect(executeFractionalize(DEPOSIT_A)).rejects.toMatchObject({ reason: 'already-wrapped' })
  })

  it('parses a Transfer receipt log into a sighting with log body', () => {
    setLabEnabled('arcUsdc', true)
    const sighting = sightingFromReceiptLog(DEPOSIT_A, {
      ...logFor(DEPOSIT_A),
      logIndex: 0,
    })
    expect(sighting.atoms).toBe('1000000')
    expect(sighting.to).toBe(RESERVE)
    expect(sighting.log?.topics[0]).toBe(ERC20_TRANSFER_TOPIC)
  })

  it('round-trips wrap then redeem via burn + payout', async () => {
    setLabEnabled('arcUsdc', true)
    setWrapVerifyForTest(okVerify)
    setWrapMintForTest(labMint())
    let spendable = 0n
    setWrapBurnForTest(async ({ atoms }) => {
      spendable = BigInt(getWrapSpendable()) - BigInt(atoms)
      return { burnTxid: BURN_TX, spendable: spendable.toString() }
    })
    setWrapPayoutForTest(async () => ({ txHash: PAYOUT_TX }))
    await executeFractionalize(DEPOSIT_A)
    spendable = BigInt(getWrapSpendable())
    const redeemed = await executeRedeem({
      chainId: ARC_MAIN,
      atoms: '1000000',
      to: RESERVE,
    })
    expect(redeemed.status).toBe('redeemed')
    expect(redeemed.burnTxid).toBe(BURN_TX)
    expect(redeemed.redeemTxHash).toBe(PAYOUT_TX)
    expect(redeemed.spendable).toBe('0')
    expect(listWrapClaims()).toHaveLength(0)
    expect(listWrapRedeems()).toHaveLength(1)
  })

  it('redeems FIFO across deposits with a partial burn', async () => {
    setLabEnabled('arcUsdc', true)
    setWrapVerifyForTest(okVerify)
    setWrapMintForTest(labMint())
    setWrapBurnForTest(async ({ atoms }) => {
      const next = BigInt(getWrapSpendable()) - BigInt(atoms)
      return { burnTxid: BURN_TX, spendable: next.toString() }
    })
    setWrapPayoutForTest(async () => ({ txHash: PAYOUT_TX }))
    await executeFractionalize(DEPOSIT_A)
    await executeFractionalize(DEPOSIT_B)
    expect(getWrapSpendable()).toBe('3500000')
    await executeRedeem({ chainId: ARC_MAIN, atoms: '1500000', to: RESERVE })
    expect(getWrapSpendable()).toBe('2000000')
    const remaining = listWrapClaims()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.id).toBe(depositClaimId('arc-mainnet', TX_B, 1))
    expect(remaining[0]?.atoms).toBe('2000000')
  })

  it('refuses redeem above spendable before burning', async () => {
    setLabEnabled('arcUsdc', true)
    setWrapVerifyForTest(okVerify)
    setWrapMintForTest(labMint())
    let burned = false
    setWrapBurnForTest(async () => {
      burned = true
      return { burnTxid: BURN_TX, spendable: '0' }
    })
    setWrapPayoutForTest(async () => ({ txHash: PAYOUT_TX }))
    await executeFractionalize(DEPOSIT_A)
    await expect(
      executeRedeem({ chainId: ARC_MAIN, atoms: '1000001', to: RESERVE }),
    ).rejects.toMatchObject({ reason: 'insufficient' })
    expect(burned).toBe(false)
    expect(getWrapSpendable()).toBe('1000000')
  })

  it('burns before payout; payout failure leaves BNT burned', async () => {
    setLabEnabled('arcUsdc', true)
    setWrapVerifyForTest(okVerify)
    setWrapMintForTest(labMint())
    setWrapBurnForTest(async ({ atoms }) => {
      const next = BigInt(getWrapSpendable()) - BigInt(atoms)
      return { burnTxid: BURN_TX, spendable: next.toString() }
    })
    setWrapPayoutForTest(async () => {
      throw new Error('rpc down')
    })
    await executeFractionalize(DEPOSIT_A)
    await expect(
      executeRedeem({ chainId: ARC_MAIN, atoms: '1000000', to: RESERVE }),
    ).rejects.toMatchObject({ reason: 'payout-failed' })
    expect(getWrapSpendable()).toBe('0')
  })
})
