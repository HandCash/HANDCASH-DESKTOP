/**
 * How a seller is allowed to accept an inbound BRC-33 market settlement receipt.
 *
 * Two different sales reach the same inbox:
 *
 * - **Sign hop** — the buyer asked us to sign the item/offer inputs, so the
 *   listing was reserved with the buyer key, an intent, and a commitment to the
 *   exact transaction shape. The receipt is matched against that reservation.
 * - **List-time unlocks** — the listing shipped pre-signed unlocks, so the buyer
 *   settled without ever contacting us. There is no reservation to match, and
 *   refusing on that basis is what left sold items unpaid: the receipt sat
 *   unacknowledged in messagebox forever. Authority comes from the settlement
 *   transaction itself — it must spend *our* item and offer outputs and pay the
 *   listing's own `payTo` and fee addresses.
 *
 * Both paths fail closed with a named reason. Nothing here mutates state.
 */
import { P2PKH } from '@bsv/sdk'
import {
  calculateMarketSettlement,
  type MarketListingAdvert,
  type MarketListingAuthorization,
} from './marketListing'

export type MarketReceiptRefusal =
  | 'no-local-listing-for-sale'
  | 'listing-not-sold-by-active-account'
  | 'reservation-buyer-mismatch'
  | 'listing-has-no-token'
  | 'listing-cancelled'
  | 'listing-settled-by-another-tx'
  | 'settlement-missing-item-input'
  | 'settlement-missing-offer-input'
  | 'seller-payment-mismatch'
  | 'fee-payment-mismatch'

export type MarketReceiptAuthority =
  | { path: 'reservedBySignHop'; authorization: MarketListingAuthorization }
  | { path: 'listTimeUnlocks'; authorization: MarketListingAuthorization }
  | { path: 'refuse'; reason: MarketReceiptRefusal }

function normalizePoint(outpoint: string): string {
  return outpoint.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
}

/**
 * Pick the authority for a receipt. `reserved` is the record found by sale id;
 * `settledLocally` is the record whose listing outputs the settlement spends.
 */
export function chooseMarketReceiptAuthority(args: {
  senderIdentityKey: string
  /** Wallet that would receive the proceeds — authorizations are not per account. */
  activeIdentityKey: string
  settlementTxid: string
  reserved: MarketListingAuthorization | null
  settledLocally: MarketListingAuthorization | null
}): MarketReceiptAuthority {
  const sender = args.senderIdentityKey.trim().toLowerCase()
  const txid = args.settlementTxid.trim().toLowerCase()
  const record = args.reserved ?? args.settledLocally
  if (!record) return { path: 'refuse', reason: 'no-local-listing-for-sale' }
  if (!record.listing) return { path: 'refuse', reason: 'listing-has-no-token' }
  // Proceeds are swept with the active root key, so only the selling account may
  // ingest this receipt — the authorization store is shared across accounts.
  if (
    record.listing.seller.trim().toLowerCase() !==
    args.activeIdentityKey.trim().toLowerCase()
  ) {
    return { path: 'refuse', reason: 'listing-not-sold-by-active-account' }
  }
  if (record.state === 'cancelled') {
    return { path: 'refuse', reason: 'listing-cancelled' }
  }
  if (record.settlementTxid && record.settlementTxid.toLowerCase() !== txid) {
    return { path: 'refuse', reason: 'listing-settled-by-another-tx' }
  }
  if (args.reserved) {
    if (args.reserved.reservationBuyer !== sender) {
      return { path: 'refuse', reason: 'reservation-buyer-mismatch' }
    }
    // A record can carry a sale id without a signed intent once a list-time sale
    // has been adopted. Only a real sign hop can be checked against a commitment.
    if (args.reserved.reservationTxCommitment && args.reserved.reservationIntent) {
      return { path: 'reservedBySignHop', authorization: args.reserved }
    }
  }
  return { path: 'listTimeUnlocks', authorization: record }
}

export type MarketSettlementPayout =
  | {
      ok: true
      sellerOutputIndex: number
      feeOutputIndex: number
      sellerSats: number
      feeSats: number
    }
  | { ok: false; reason: MarketReceiptRefusal }

/**
 * Confirm a settlement transaction really is this listing's sale: it spends the
 * listed item and its offer token, and it pays the listing's seller and fee
 * addresses at least the amounts the offer terms demand.
 */
export function verifyMarketSettlementPayout(args: {
  listing: MarketListingAdvert
  spentOutpoints: string[]
  outputs: Array<{ satoshis?: number; lockingScriptHex?: string }>
}): MarketSettlementPayout {
  const spent = new Set(args.spentOutpoints.map(normalizePoint))
  if (!spent.has(normalizePoint(args.listing.outpoint))) {
    return { ok: false, reason: 'settlement-missing-item-input' }
  }
  if (!spent.has(normalizePoint(args.listing.offerOutpoint))) {
    return { ok: false, reason: 'settlement-missing-offer-input' }
  }
  const { sellerSats, feeSats } = calculateMarketSettlement(args.listing.priceSats)
  const sellerLock = new P2PKH().lock(args.listing.payTo).toHex().toLowerCase()
  const feeLock = new P2PKH().lock(args.listing.feePayTo).toHex().toLowerCase()
  const paysAtLeast = (lock: string, sats: number): number =>
    args.outputs.findIndex(
      (output) =>
        (output.lockingScriptHex ?? '').toLowerCase() === lock &&
        (output.satoshis ?? 0) >= sats,
    )
  const sellerOutputIndex = paysAtLeast(sellerLock, sellerSats)
  if (sellerOutputIndex < 0) return { ok: false, reason: 'seller-payment-mismatch' }
  const feeOutputIndex = paysAtLeast(feeLock, feeSats)
  if (feeOutputIndex < 0) return { ok: false, reason: 'fee-payment-mismatch' }
  return { ok: true, sellerOutputIndex, feeOutputIndex, sellerSats, feeSats }
}
