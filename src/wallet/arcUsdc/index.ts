/**
 * Wrap Arc USD → BSV claim units (Settings → Labs → Wrap Arc USD, off by default).
 *
 * Arc USD as a currency is always supported; only this wrap path is experimental.
 * Cross-chain only for Circle Arc USDC. Not the BSV Association ARC broadcaster.
 */

export {
  ARC_NETWORKS,
  ARC_USDC_DECIMALS,
  ARC_USDC_ERC20,
  arcNetworkOf,
  assertArcUsdcOnly,
  isArcChainId,
  isArcUsdcToken,
  type ArcNetwork,
} from './chain'

export {
  ARC_USDC_LAB_ID,
  arcUsdcLabEnabled,
  planFractionalize,
  planRedeem,
  type ArcUsdcAtoms,
  type ArcUsdcDeposit,
  type FractionalizePlan,
} from './fractionalize'
