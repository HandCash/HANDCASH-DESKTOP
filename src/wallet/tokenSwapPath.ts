import type { Bsv21BinaryLayout } from './token/decode162'
import { normalizeTokenId } from './token/types'
import { MARKET_SELLER_SIGHASH_BYTE, unlockSighashByte } from './marketSettlementLayout'

/**
 * P2P token swap vocabulary.
 *
 * A maker escrows an exact BRC-162 lot at its own address and signs that one
 * input SIGHASH_SINGLE|ANYONECANPAY. The signature binds output 0 — what the
 * maker wants back — and nothing else, so any taker can complete the
 * transaction by funding output 0 and taking the lot, and nobody can take the
 * lot while paying less. The offer is the signed input plus its BEEF; no index
 * or server decides who may take it.
 */

export const TOKEN_SWAP_PROTOCOL = 'handcash-token-swap' as const
export const TOKEN_SWAP_VERSION = 1 as const
/** Escrowed give lots are filed here so token send / burn never select them. */
export const TOKEN_SWAP_BASKET = 'token-swap-offers' as const
export const TOKEN_SWAP_MAKER_SIGHASH_BYTE = MARKET_SELLER_SIGHASH_BYTE
export const TOKEN_SWAP_GIVE_VIN = 0
export const TOKEN_SWAP_WANT_VOUT = 0
export const TOKEN_SWAP_TAKER_VOUT = 1
/** Sats offers below this are dust a miner may refuse. */
export const TOKEN_SWAP_MIN_SATS = 1

export type TokenSwapWant =
  | { kind: 'sats'; sats: number }
  | {
      kind: 'token'
      tokenId: string
      amount: string
      layout: Bsv21BinaryLayout
      sym?: string
      dec?: number
    }

export type TokenSwapGive = {
  tokenId: string
  amount: string
  dec: number
  sym?: string
  icon?: string
  lockingScript: string
}

/** The shareable offer. Changing any field the maker signed breaks input 0. */
export type TokenSwapOffer = {
  protocol: typeof TOKEN_SWAP_PROTOCOL
  v: typeof TOKEN_SWAP_VERSION
  /** The escrowed give outpoint, `txid.vout`. */
  offerId: string
  maker: string
  payTo: string
  give: TokenSwapGive
  want: TokenSwapWant
  makerUnlockingScript: string
  /** BEEF carrying the give transaction and its ancestry. */
  beefB64: string
  createdAt: number
}

export type TokenSwapOfferState = 'open' | 'taken' | 'claimed' | 'cancelled'

export type TokenSwapRefusal =
  | 'invalid-offer'
  | 'unbound-signature'
  | 'same-token'
  | 'bad-amount'
  | 'cosigned-token'
  | 'want-layout-mismatch'
  | 'not-maker'
  | 'offer-not-open'
  | 'offer-not-taken'
  | 'offer-already-taken'

const REFUSAL_MESSAGE: Record<TokenSwapRefusal, string> = {
  'invalid-offer': 'This is not a valid token swap offer.',
  'unbound-signature':
    'The offer signature does not bind what the maker wants back, so it cannot be taken safely.',
  'same-token': 'A swap must exchange two different assets.',
  'bad-amount': 'Swap amounts must be positive whole units.',
  'cosigned-token':
    'Issuer-cosigned tokens need the issuer’s signature on every transfer and cannot be swapped.',
  'want-layout-mismatch':
    'Your tokens use a different token format from the one this offer asks for.',
  'not-maker': 'Only the wallet that made this offer can do that.',
  'offer-not-open': 'This offer is no longer open.',
  'offer-not-taken': 'Nobody has taken this offer yet.',
  'offer-already-taken': 'This offer was already taken on chain.',
}

export class TokenSwapError extends Error {
  constructor(
    readonly code: TokenSwapRefusal | 'TOKEN_SWAP_UNPROVEN' | 'TOKEN_SWAP_SHAPE_MISMATCH' | 'INSUFFICIENT_FUNDS',
    message: string,
  ) {
    super(message)
    this.name = 'TokenSwapError'
  }
}

export function tokenSwapRefusalMessage(reason: TokenSwapRefusal): string {
  return REFUSAL_MESSAGE[reason]
}

export type TokenSwapRefuse = { path: 'refuse'; reason: TokenSwapRefusal; message: string }

function refuse(reason: TokenSwapRefusal): TokenSwapRefuse {
  return { path: 'refuse', reason, message: REFUSAL_MESSAGE[reason] }
}

export type TokenSwapMakePath =
  | { path: 'make'; tokenId: string; amount: bigint; want: TokenSwapWant }
  | TokenSwapRefuse

/**
 * Who completes the maker side after a take.
 * `selfClaim` — maker and taker are this wallet: the want output is filed
 * locally. `peerClaim` — the maker claims output 0 with the take txid.
 */
export type TokenSwapTakePath =
  | { path: 'take'; settle: 'selfClaim' | 'peerClaim'; offer: TokenSwapOffer }
  | TokenSwapRefuse

/** How the maker files output 0: a P2PKH sweep, or a token ingest. */
export type TokenSwapClaimPath =
  | { path: 'claim'; proceeds: 'sats' | 'token'; offerId: string; txid: string }
  | TokenSwapRefuse

export type TokenSwapCancelPath =
  | { path: 'cancel'; offerId: string }
  | TokenSwapRefuse

export type TokenSwapPath =
  | TokenSwapMakePath
  | TokenSwapTakePath
  | TokenSwapClaimPath
  | TokenSwapCancelPath

function positiveUnits(value: unknown): bigint | null {
  const text = typeof value === 'bigint' ? value.toString() : String(value ?? '').trim()
  if (!/^\d+$/.test(text)) return null
  const units = BigInt(text)
  return units > 0n ? units : null
}

function wantOf(raw: unknown): TokenSwapWant | null {
  if (!raw || typeof raw !== 'object') return null
  const want = raw as Record<string, unknown>
  if (want.kind === 'sats') {
    const sats = Number(want.sats)
    return Number.isSafeInteger(sats) && sats >= TOKEN_SWAP_MIN_SATS ? { kind: 'sats', sats } : null
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

export function chooseTokenSwapMakePath(args: {
  tokenId: unknown
  amount: unknown
  want: unknown
  cosigned: boolean
}): TokenSwapMakePath {
  const tokenId = normalizeTokenId(String(args.tokenId ?? ''))
  const amount = positiveUnits(args.amount)
  if (!tokenId) return refuse('invalid-offer')
  if (amount == null) return refuse('bad-amount')
  const want = wantOf(args.want)
  if (!want) return refuse('bad-amount')
  if (want.kind === 'token' && want.tokenId === tokenId) return refuse('same-token')
  if (args.cosigned) return refuse('cosigned-token')
  return { path: 'make', tokenId, amount, want }
}

/** Structural parse of a shared offer. Script and lineage checks run on take. */
export function parseTokenSwapOffer(raw: unknown): TokenSwapOffer | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.protocol !== TOKEN_SWAP_PROTOCOL || o.v !== TOKEN_SWAP_VERSION) return null
  const offerId = String(o.offerId ?? '').trim().toLowerCase().replace('_', '.')
  if (!/^[0-9a-f]{64}\.\d+$/.test(offerId)) return null
  const maker = String(o.maker ?? '').trim().toLowerCase()
  if (!/^0[23][0-9a-f]{64}$/.test(maker)) return null
  const payTo = String(o.payTo ?? '').trim()
  if (!payTo) return null
  const give = o.give as Record<string, unknown> | undefined
  const giveTokenId = normalizeTokenId(String(give?.tokenId ?? ''))
  const giveAmount = positiveUnits(give?.amount)
  const lockingScript = String(give?.lockingScript ?? '').trim().toLowerCase()
  if (!giveTokenId || giveAmount == null || !/^[0-9a-f]+$/.test(lockingScript)) return null
  const want = wantOf(o.want)
  if (!want) return null
  const makerUnlockingScript = String(o.makerUnlockingScript ?? '').trim().toLowerCase()
  const beefB64 = String(o.beefB64 ?? '').trim()
  if (!makerUnlockingScript || !beefB64) return null
  return {
    protocol: TOKEN_SWAP_PROTOCOL,
    v: TOKEN_SWAP_VERSION,
    offerId,
    maker,
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
    makerUnlockingScript,
    beefB64,
    createdAt: Number(o.createdAt) || 0,
  }
}

export function chooseTokenSwapTakePath(args: {
  offer: unknown
  takerIdentityKey: string
}): TokenSwapTakePath {
  const offer = parseTokenSwapOffer(args.offer)
  if (!offer) return refuse('invalid-offer')
  if (unlockSighashByte(offer.makerUnlockingScript) !== TOKEN_SWAP_MAKER_SIGHASH_BYTE) {
    return refuse('unbound-signature')
  }
  if (offer.want.kind === 'token' && offer.want.tokenId === offer.give.tokenId) {
    return refuse('same-token')
  }
  return {
    path: 'take',
    settle:
      offer.maker === args.takerIdentityKey.trim().toLowerCase() ? 'selfClaim' : 'peerClaim',
    offer,
  }
}

export function chooseTokenSwapClaimPath(args: {
  offer: TokenSwapOffer
  state: TokenSwapOfferState
  makerIdentityKey: string
  txid: unknown
}): TokenSwapClaimPath {
  if (args.offer.maker !== args.makerIdentityKey.trim().toLowerCase()) return refuse('not-maker')
  if (args.state === 'claimed' || args.state === 'cancelled') return refuse('offer-not-open')
  const txid = String(args.txid ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid)) return refuse('offer-not-taken')
  return {
    path: 'claim',
    proceeds: args.offer.want.kind,
    offerId: args.offer.offerId,
    txid,
  }
}

export function chooseTokenSwapCancelPath(args: {
  offer: TokenSwapOffer
  state: TokenSwapOfferState
  makerIdentityKey: string
  spent: 'spent' | 'unspent' | 'unknown' | null
}): TokenSwapCancelPath {
  if (args.offer.maker !== args.makerIdentityKey.trim().toLowerCase()) return refuse('not-maker')
  if (args.state !== 'open') return refuse('offer-not-open')
  if (args.spent === 'spent') return refuse('offer-already-taken')
  return { path: 'cancel', offerId: args.offer.offerId }
}
