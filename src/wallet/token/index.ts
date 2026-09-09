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
  cosignFromRemittance,
  detectCosignFromLockingScript,
  formatFungibleAmount,
  isBsv21Mime,
  issuerFromRemittance,
  issuerFromSigmaLockingScript,
  normalizeTokenId,
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
export { combineColourTips, sendColourCoins } from './send'

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
export { burnColourCoins, previewColourBurn } from './burn'

// BRC-176 prove
export { fillTokenParentBodies, prove, type Bsv21ProofResult } from './prove176'

// Settle (P2P receive)
export { internalizePeerFungibleSettle } from './settle'
export { internalizePeerColourSettle } from './settleLegacy'

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
  resolveOnesatFtIconDataUrl,
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

// Collectable / NFT guards (deprecated 1sat-ft detection only)
export {
  aggregateColourTokens,
  assertColourAmtConservation,
  buildColourCustomInstructions,
  buildOnesatFtOriginInscriptionJson,
  evaluateColourSupply,
  isOnesatFtAmtHop,
  isOnesatFtMime,
  looksLikeOnesatFtTip,
  mergeColourRemittance,
  normalizeColourOrigin,
  ONESAT_FT_TAG,
  ONESAT_FT_MIME,
  issuerFromColourTags,
  originFromColourCi,
  originFromOnesatFtLock,
  parseColourTipAmt,
  parseOnesatFtOriginPolicy,
  selectColourTipsForAmount,
  shortOriginLabel,
  tryParseProvenanceFromCi,
  verifyColourTipProvenance,
  type ColourTip,
  type ColourToken,
} from './guards'

// Legacy JSON inscribe helpers (burn path)
export {
  buildBsv21BurnLockingScript,
  buildBsv21TransferLockingScript,
} from './legacyInscribe'

// Preferred aliases for new code
export { listFungibles as listTokens } from './list'
export { sendFungible as sendToken } from './sendEntry'
export { burnColourCoins as burnToken } from './burn'
export { combineColourTips as combineToken } from './send'
