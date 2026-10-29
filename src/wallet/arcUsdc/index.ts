/**
 * Arc USD: native hold / send / receive on Arc, plus optional Labs wrap onto BSV.
 *
 * Not the BSV Association ARC broadcaster. Cross-chain wrap is Arc USDC only.
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

export {
  ARC_USD_DECIMALS,
  ARC_USD_KEY_ID,
  ARC_USD_KEY_PROTOCOL,
  ARC_USD_PAYMENT_ETA,
  ArcUsdRefusalError,
  arcUsdCoinKey,
  arcUsdWallet,
  setArcUsdRpcForTest,
  type ArcUsdWallet,
  type SendArcUsdArgs,
  type SendArcUsdResult,
} from './arcUsdWallet'

export {
  ArcWrapRefusalError,
  ERC20_TRANSFER_TOPIC,
  depositClaimId,
  encodeTransferLogData,
  executeFractionalize,
  executeRedeem,
  getWrapAssetId,
  getWrapSpendable,
  listWrapClaims,
  listWrapRedeems,
  padAddressTopic,
  resetWrapStoreForTest,
  setWrapBurnForTest,
  setWrapMintForTest,
  setWrapPayoutForTest,
  setWrapReserveForTest,
  setWrapRpcForTest,
  setWrapVerifyForTest,
  sightingFromReceiptLog,
  subscribeWrap,
  transferTopic0,
  type BurnWrapUnits,
  type DepositSighting,
  type MintWrapUnits,
  type PayoutArcUsdc,
  type RedeemResult,
  type VerifyArcDeposit,
  type WrapClaim,
  type WrapRedeem,
  type WrapResult,
} from './wrap'

export {
  arcDepositOutpoint,
  arcReceiptProofOf,
  arcReserveHex,
  checkArcReceiptProof,
  type ArcReceiptProof,
} from './backing'

export { ethAddressFromPrivateKey, isEthAddress, toChecksumAddress } from './address'
export { formatUsdcAtoms, parseUsdcAtoms } from './erc20'
