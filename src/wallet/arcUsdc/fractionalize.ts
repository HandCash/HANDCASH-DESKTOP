/**
 * Wrap Arc USD onto BSV claim units (lab / experimental).
 *
 * Arc USD itself is a normal wallet currency (display + asset profile). Only
 * this wrap path is Labs-gated. Shape mirrors the retired BRC-212 “deposit on
 * foreign chain → BSV token units” idea; the foreign leg is **Circle Arc USDC
 * only** — never Ethereum / Solana / other USDC. Settings → Labs → Wrap Arc USD
 * must be on.
 *
 * This module plans and validates; mint / redeem against a live Arc RPC and
 * BSV BNT deploy stay behind the same gate and are unfinished until the lab
 * path is proven.
 */

import { isLabEnabled } from '../labs'
import {
  ARC_USDC_DECIMALS,
  ARC_USDC_ERC20,
  assertArcUsdcOnly,
  type ArcNetwork,
} from './chain'

export const ARC_USDC_LAB_ID = 'arcUsdc' as const

/** Smallest Arc USDC unit (6 decimals), as a decimal string of an integer. */
export type ArcUsdcAtoms = string

export type ArcUsdcDeposit = {
  chainId: number
  /** Arc USDC ERC-20; omitted defaults to the Arc predeploy. */
  tokenAddress?: string
  /** Arc tx hash (0x…), 32 bytes. */
  txHash: string
  /** Log / transfer index of the USDC credit on Arc. */
  logIndex: number
  /** Amount in 6-decimal atoms. */
  atoms: ArcUsdcAtoms
}

export type FractionalizePlan = {
  network: ArcNetwork
  tokenAddress: typeof ARC_USDC_ERC20
  decimals: typeof ARC_USDC_DECIMALS
  deposit: {
    txHash: string
    logIndex: number
    atoms: ArcUsdcAtoms
  }
  /** BSV-side symbol for the fractional claim token. */
  bsvSymbol: 'USDC'
  /** Human label while the lab path is unfinished. */
  status: 'planned'
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/
const ATOMS = /^[1-9][0-9]*$/

export function arcUsdcLabEnabled(): boolean {
  return isLabEnabled(ARC_USDC_LAB_ID)
}

function requireLab(): void {
  if (!arcUsdcLabEnabled()) {
    throw new Error(
      'ARC_USDC_LAB: turn on Settings → Labs → Wrap Arc USD on this device first',
    )
  }
}

function readAtoms(atoms: unknown): ArcUsdcAtoms {
  if (typeof atoms !== 'string' || !ATOMS.test(atoms)) {
    throw new Error('ARC_USDC_ATOMS: amount must be a positive integer string of 6-decimal atoms')
  }
  return atoms
}

function readTxHash(hash: unknown): string {
  if (typeof hash !== 'string' || !TX_HASH.test(hash)) {
    throw new Error('ARC_USDC_TX: deposit txHash must be 0x + 64 hex chars')
  }
  return hash.toLowerCase()
}

/**
 * Build a fractionalize plan from an Arc USDC deposit. Refuses non-Arc chains
 * and non-Arc USDC tokens even when the lab flag is on.
 */
export function planFractionalize(deposit: ArcUsdcDeposit): FractionalizePlan {
  requireLab()
  const network = assertArcUsdcOnly({
    chainId: deposit.chainId,
    tokenAddress: deposit.tokenAddress ?? ARC_USDC_ERC20,
  })
  if (!Number.isInteger(deposit.logIndex) || deposit.logIndex < 0) {
    throw new Error('ARC_USDC_LOG: logIndex must be a non-negative integer')
  }
  return {
    network,
    tokenAddress: ARC_USDC_ERC20,
    decimals: ARC_USDC_DECIMALS,
    deposit: {
      txHash: readTxHash(deposit.txHash),
      logIndex: deposit.logIndex,
      atoms: readAtoms(deposit.atoms),
    },
    bsvSymbol: 'USDC',
    status: 'planned',
  }
}

/**
 * Redeem path: BSV fractional units → Arc USDC payout. Same Arc-only gate.
 * Returns a plan stub; broadcasting is unfinished under the lab flag.
 */
export function planRedeem(args: {
  chainId: number
  atoms: ArcUsdcAtoms
  /** Arc payout address (0x…). */
  to: string
}): {
  network: ArcNetwork
  atoms: ArcUsdcAtoms
  to: string
  status: 'planned'
} {
  requireLab()
  const network = assertArcUsdcOnly({ chainId: args.chainId, tokenAddress: ARC_USDC_ERC20 })
  if (typeof args.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(args.to)) {
    throw new Error('ARC_USDC_TO: payout must be a 20-byte 0x Arc address')
  }
  return {
    network,
    atoms: readAtoms(args.atoms),
    to: args.to.toLowerCase(),
    status: 'planned',
  }
}
