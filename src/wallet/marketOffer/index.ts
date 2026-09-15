/**
 * 1Sat market offer wire (BRC-48 PushDrop) — Desktop encoder is SSoT.
 *
 * Overlay admit lives in BRC-CLOUD `marketOverlayProtocol.js` and must agree
 * on MINIMALDATA. Shared field fixtures: `./fixtures/canonical.json`.
 */

export {
  MARKET_ITEM_VOUT,
  MARKET_MAX_PROVENANCE_JSON_BYTES,
  MARKET_OFFER_DEPOSIT_SATS,
  MARKET_OFFER_MAGIC,
  MARKET_OFFER_VOUT,
  MARKET_OFFER_VERSION,
  MARKET_OVERLAY_HYDRATE_MAX_TXS,
  encodeMarketOffer,
  marketOfferUsesMinimalPushes,
  parseMarketOffer,
  type MarketOfferFields,
} from '../marketOverlayProtocol'
