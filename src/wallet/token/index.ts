/**
 * BRC-162 + BRC-163 fungible tokens (basket `bsv21`).
 *
 * Single public surface for Collect → Tokens, market, settle, and BRC-100 issuer.
 * Regular BSV payments and 1sat collectables stay outside this module.
 */

// Types + remittance (BRC-163)
export {
  BSV21_BASKET,
  BSV21_MIME,
  BSV21_PROTOCOL,
  aggregateFungibles,
  buildBsv21CustomInstructions,
  bsv21Tags,
  classifyFungibleEncoding,
  cosignFromRemittance,
  detectCosignFromLockingScript,
  formatFungibleAmount,
  isBsv21Mime,
  issuerFromBsv21Tags,
  issuerFromRemittance,
  issuerFromSigmaLockingScript,
  normalizeTokenId,
  requireTokenId,
  parseBsv21CustomInstructions,
  parseBsv21Json,
  shortIssuerLabel,
  shortTokenLabel,
  tokenIdForPayload,
  tokenIdForListedTip,
  tokenIdFromBsv21Tags,
  chooseBsv21BatchSendPath,
  chooseBsv21SendPath,
  classifyBsv21TipKind,
  normalizeCosignPubKey,
  normalizeIssuerPubKey,
  parseBsv21Cosign,
  type Bsv21Cosign,
  type Bsv21ImportItem,
  type Bsv21Op,
  type Bsv21Payload,
  type Bsv21Utxo,
  type FungibleToken,
  type FungibleEncoding,
} from './types'

// BRC-162 decode / encode
export {
  BSV21_TAG,
  BSV21_TAG_HEX,
  decodeBsv21Binary,
  encodeBsv21Binary,
  encodeScriptNumber,
  iconOutpointFromPayload,
  isBsv21BinaryScript,
  parseDisplayOutpoint,
  tokenIdFromWire,
  tokenIdToWire,
  type Bsv21Binary,
  type Bsv21BinaryPayload,
  type Bsv21BinaryRole,
} from './decode162'

// List + cache
export {
  areFungiblesHydrated,
  clearFungiblesCache,
  forgetFungibleToken,
  fungibleFromImport,
  getCachedFungibles,
  getFungible,
  hydrateCachedTokenIcons,
  importBsv21Tokens,
  listFungibles,
  listFungibleTips,
  paintFungibleAfterSpend,
  proveCachedFungibleEncoding,
  proveCachedFungibleEncodings,
  rememberFungibleToken,
  subscribeFungibles,
} from './list'

export {
  listBsv21BinaryTips,
  listBsv21BinaryTokens,
  decodeListedBsv21Tip,
  stampBsv21IconOnListedOutputs,
} from './listTips'

// Send / receive
export {
  combineBsv21Tips,
  sendBsv21Tokens,
  signBsv21TipTransfer,
} from './send'

export {
  buildFungibleInputBeef,
  parseFungibleSendAmount,
  selectFungibleTips,
  sendFungible,
  withFungibleCreateActionTimeout,
  FUNGIBLE_CREATE_ACTION_TIMEOUT_MS,
} from './sendEntry'

export {
  assertBsv21AmtConservation,
  assertBsv21SendConservation,
  buildBsv21SendOutputs,
  buildBsv21SendRemittance,
  buildBsv21SubjectBeef,
  buildBsv21ValueLock,
  classifyBsv21SendOutputs,
  planBsv21Send,
  tipFromBsv21Script,
} from './sendPlan'

export { bsv21SendMachine } from './sendMachine'

// Burn
export { burnBsv21Tokens, previewBsv21Burn } from './burn'

// BRC-176 prove
export { fillTokenParentBodies, prove, type Bsv21ProofResult } from './prove176'

// Settle (P2P receive)
export { internalizePeerFungibleSettle } from './settle'

// Icons
export {
  getTokenIconDataUrl,
  rememberTokenIcon,
  tokenIconBytes,
} from './icons/cache'
export {
  cacheTokenIconFromBeef,
  mergeIconTxIntoBeef,
  resolveBsv21IconDataUrl,
  resolveTokenIconDataUrl,
} from './icons/resolve'

// Market view overlay
export {
  attachMarketListingToToken,
  listActiveBsv21MarketListings,
  tokenMarketPriceHistory,
  type TokenMarketPricePoint,
} from './marketView'

// BRC-100 issuer enrich
export {
  bsv21IdentityMintHints,
  enrichCreateActionForBsv21Issuer,
  finishBsv21IdentityMintCreateAction,
  completeBsv21SignableWithRootP2pkh,
  injectIconIntoBsv21DeployScript,
  findPriorBsv21Icon,
  isBsv21DeployMintOutput,
  isBsv21IdentityIssuanceOutput,
  isBsv21IdentityMintArgs,
  sigmaSignDeployLockingScript,
} from './issuer'

// Legacy JSON inscribe helpers (burn path)
export {
  buildBsv21BurnLockingScript,
  buildBsv21TransferLockingScript,
} from './legacyInscribe'

// Stable feature aliases
export { listFungibles as listTokens } from './list'
export { sendFungible as sendToken } from './sendEntry'
export { burnBsv21Tokens as burnToken } from './burn'
export { combineBsv21Tips as combineToken } from './send'
