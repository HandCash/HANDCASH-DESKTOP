import { normalizeTokenId } from './token/types'
import type { Bsv21BinaryLayout } from './token/decode162'
import { unlockSighashByte } from './offerSeal'
import { SELLER_SIGHASH_BYTE, type OfferWant } from './offerTerms'

/**
 * Direct offer vocabulary: the `direct` venue of the one offer mechanism
 * (`offerTerms.ts`).
 *
 * The seller holds an exact BRC-162 lot at its own address and signs that one
 * input SIGHASH_SINGLE|ANYONECANPAY over output 0, what it wants back. Any
 * buyer completes the transaction by paying output 0 and taking the lot, and
 * nobody can take the lot while paying less. The offer is the signed input
 * plus its BEEF; no index or server decides who may buy it.
 */

export const DIRECT_OFFER_PROTOCOL = 'handcash-direct-offer' as const
export const DIRECT_OFFER_VERSION = 1 as const
/** Listed lots are filed here so token send / burn never select them. */
export const DIRECT_OFFER_BASKET = 'direct-offers' as const
/** Where 1.3.573 filed listed lots, when direct offers were named token swaps. */
export const DIRECT_OFFER_LEGACY_BASKET = 'token-swap-offers' as const
export const DIRECT_OFFER_LOT_VIN = 0
export const DIRECT_OFFER_PRICE_VOUT = 0
export const DIRECT_OFFER_BUYER_VOUT = 1
/** Sats offers below this are dust a miner may refuse. */
export const DIRECT_OFFER_MIN_SATS = 1

export type DirectOfferLot = {
  tokenId: string
  amount: string
  dec: number
  sym?: string
  icon?: string
  lockingScript: string
}

/** The shareable offer. Changing any field the seller signed breaks input 0. */
export type DirectOffer = {
  protocol: typeof DIRECT_OFFER_PROTOCOL
  v: typeof DIRECT_OFFER_VERSION
  /** The listed lot outpoint, `txid.vout`. */
  offerId: string
  seller: string
  payTo: string
  give: DirectOfferLot
  want: OfferWant
  sellerUnlockingScript: string
  /** BEEF carrying the listing transaction and its ancestry. */
  beefB64: string
  createdAt: number
}

export type DirectOfferState = 'listed' | 'sold' | 'collected' | 'cancelled'

export type DirectOfferRefusal =
  | 'invalid-offer'
  | 'unbound-signature'
  | 'same-token'
  | 'bad-amount'
  | 'cosigned-token'
  | 'want-layout-mismatch'
  | 'not-seller'
  | 'offer-not-listed'
  | 'offer-not-sold'
  | 'offer-already-sold'

const REFUSAL_MESSAGE: Record<DirectOfferRefusal, string> = {
  'invalid-offer': 'This is not a valid direct offer.',
  'unbound-signature':
    'The offer signature does not bind what the seller wants back, so it cannot be bought safely.',
  'same-token': 'An offer must exchange two different assets.',
  'bad-amount': 'Offer amounts must be positive whole units.',
  'cosigned-token':
    'Issuer-cosigned tokens need the issuer’s signature on every transfer and cannot be listed.',
  'want-layout-mismatch':
    'Your tokens use a different token format from the one this offer asks for.',
  'not-seller': 'Only the wallet that listed this offer can do that.',
  'offer-not-listed': 'This offer is no longer listed.',
  'offer-not-sold': 'Nobody has bought this offer yet.',
  'offer-already-sold': 'This offer was already bought on chain.',
}

export class DirectOfferError extends Error {
  constructor(
    readonly code:
      | DirectOfferRefusal
      | 'DIRECT_OFFER_UNPROVEN'
      | 'DIRECT_OFFER_SHAPE_MISMATCH'
      | 'INSUFFICIENT_FUNDS',
    message: string,
  ) {
    super(message)
    this.name = 'DirectOfferError'
  }
}

export function directOfferRefusalMessage(reason: DirectOfferRefusal): string {
  return REFUSAL_MESSAGE[reason]
}

export type DirectOfferRefuse = { path: 'refuse'; reason: DirectOfferRefusal; message: string }

export function refuseDirectOffer(reason: DirectOfferRefusal): DirectOfferRefuse {
  return { path: 'refuse', reason, message: REFUSAL_MESSAGE[reason] }
}

export type DirectOfferListPath =
  | { path: 'list'; tokenId: string; amount: bigint; want: OfferWant }
  | DirectOfferRefuse

/**
 * Who files the seller side after a purchase.
 * `selfCollect` — seller and buyer are this wallet: output 0 is filed
 * locally. `peerCollect` — the seller collects output 0 with the purchase txid.
 */
export type DirectOfferBuyPath =
  | { path: 'buy'; settle: 'selfCollect' | 'peerCollect'; offer: DirectOffer }
  | DirectOfferRefuse

/** How the seller files output 0: a P2PKH sweep, or a token ingest. */
export type DirectOfferCollectPath =
  | { path: 'collect'; proceeds: 'sats' | 'token'; offerId: string; txid: string }
  | DirectOfferRefuse

export type DirectOfferCancelPath =
  | { path: 'cancel'; offerId: string }
  | DirectOfferRefuse

function positiveUnits(value: unknown): bigint | null {
  const text = typeof value === 'bigint' ? value.toString() : String(value ?? '').trim()
  if (!/^\d+$/.test(text)) return null
  const units = BigInt(text)
  return units > 0n ? units : null
}

function wantOf(raw: unknown): OfferWant | null {
  if (!raw || typeof raw !== 'object') return null
  const want = raw as Record<string, unknown>
  if (want.kind === 'sats') {
    const sats = Number(want.sats)
    return Number.isSafeInteger(sats) && sats >= DIRECT_OFFER_MIN_SATS ? { kind: 'sats', sats } : null
  }
  if (want.kind !== 'token') return null
  const tokenId = normalizeTokenId(String(want.tokenId ?? ''))
  const amount = positiveUnits(want.amount)
  const layout = want.layout ?? 'brc162'
  if (!tokenId || amount == null || typeof layout !== 'string') return null
  return {
    kind: 'token',
    tokenId,
    amount: amount.toString(),
    layout: layout as Bsv21BinaryLayout,
    ...(typeof want.sym === 'string' && want.sym.trim() ? { sym: want.sym.trim() } : {}),
    ...(Number.isInteger(want.dec) ? { dec: want.dec as number } : {}),
  }
}

export function chooseDirectOfferListPath(args: {
  tokenId: unknown
  amount: unknown
  want: unknown
  cosigned: boolean
}): DirectOfferListPath {
  const tokenId = normalizeTokenId(String(args.tokenId ?? ''))
  const amount = positiveUnits(args.amount)
  if (!tokenId) return refuseDirectOffer('invalid-offer')
  if (amount == null) return refuseDirectOffer('bad-amount')
  const want = wantOf(args.want)
  if (!want) return refuseDirectOffer('bad-amount')
  if (want.kind === 'token' && want.tokenId === tokenId) return refuseDirectOffer('same-token')
  if (args.cosigned) return refuseDirectOffer('cosigned-token')
  return { path: 'list', tokenId, amount, want }
}

/** Structural parse of a shared offer. Script and lineage checks run on purchase. */
export function parseDirectOffer(raw: unknown): DirectOffer | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.protocol !== DIRECT_OFFER_PROTOCOL || o.v !== DIRECT_OFFER_VERSION) return null
  const offerId = String(o.offerId ?? '').trim().toLowerCase().replace('_', '.')
  if (!/^[0-9a-f]{64}\.\d+$/.test(offerId)) return null
  const seller = String(o.seller ?? '').trim().toLowerCase()
  if (!/^0[23][0-9a-f]{64}$/.test(seller)) return null
  const payTo = String(o.payTo ?? '').trim()
  if (!payTo) return null
  const give = o.give as Record<string, unknown> | undefined
  const giveTokenId = normalizeTokenId(String(give?.tokenId ?? ''))
  const giveAmount = positiveUnits(give?.amount)
  const lockingScript = String(give?.lockingScript ?? '').trim().toLowerCase()
  if (!giveTokenId || giveAmount == null || !/^[0-9a-f]+$/.test(lockingScript)) return null
  const want = wantOf(o.want)
  if (!want) return null
  const sellerUnlockingScript = String(o.sellerUnlockingScript ?? '').trim().toLowerCase()
  const beefB64 = String(o.beefB64 ?? '').trim()
  if (!sellerUnlockingScript || !beefB64) return null
  return {
    protocol: DIRECT_OFFER_PROTOCOL,
    v: DIRECT_OFFER_VERSION,
    offerId,
    seller,
    payTo,
    give: {
      tokenId: giveTokenId,
      amount: giveAmount.toString(),
      dec: Number.isInteger(give?.dec) ? (give!.dec as number) : 0,
      ...(typeof give?.sym === 'string' && give.sym.trim() ? { sym: give.sym.trim() } : {}),
      ...(typeof give?.icon === 'string' && give.icon.trim() ? { icon: give.icon.trim() } : {}),
      lockingScript,
    },
    want,
    sellerUnlockingScript,
    beefB64,
    createdAt: Number(o.createdAt) || 0,
  }
}

export function chooseDirectOfferBuyPath(args: {
  offer: unknown
  buyerIdentityKey: string
}): DirectOfferBuyPath {
  const offer = parseDirectOffer(args.offer)
  if (!offer) return refuseDirectOffer('invalid-offer')
  if (unlockSighashByte(offer.sellerUnlockingScript) !== SELLER_SIGHASH_BYTE) {
    return refuseDirectOffer('unbound-signature')
  }
  if (offer.want.kind === 'token' && offer.want.tokenId === offer.give.tokenId) {
    return refuseDirectOffer('same-token')
  }
  return {
    path: 'buy',
    settle:
      offer.seller === args.buyerIdentityKey.trim().toLowerCase() ? 'selfCollect' : 'peerCollect',
    offer,
  }
}

export function chooseDirectOfferCollectPath(args: {
  offer: DirectOffer
  state: DirectOfferState
  sellerIdentityKey: string
  txid: unknown
}): DirectOfferCollectPath {
  if (args.offer.seller !== args.sellerIdentityKey.trim().toLowerCase()) {
    return refuseDirectOffer('not-seller')
  }
  if (args.state === 'collected' || args.state === 'cancelled') {
    return refuseDirectOffer('offer-not-listed')
  }
  const txid = String(args.txid ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid)) return refuseDirectOffer('offer-not-sold')
  return {
    path: 'collect',
    proceeds: args.offer.want.kind,
    offerId: args.offer.offerId,
    txid,
  }
}

export function chooseDirectOfferCancelPath(args: {
  offer: DirectOffer
  state: DirectOfferState
  sellerIdentityKey: string
  spent: 'spent' | 'unspent' | 'unknown' | null
}): DirectOfferCancelPath {
  if (args.offer.seller !== args.sellerIdentityKey.trim().toLowerCase()) {
    return refuseDirectOffer('not-seller')
  }
  if (args.state !== 'listed') return refuseDirectOffer('offer-not-listed')
  if (args.spent === 'spent') return refuseDirectOffer('offer-already-sold')
  return { path: 'cancel', offerId: args.offer.offerId }
}
