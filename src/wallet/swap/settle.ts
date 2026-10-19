import { Hash, KeyDeriver, PrivateKey, Utils } from '@bsv/sdk'
import { fromHex, toHex, type Bytes } from '../ltc/litecoin'
import type { SwapAsset } from './assets'
import { htlcOutput, htlcScript, type HtlcTerms } from './htlc'
import { fillOffer, offerRoom, verifySwapOffer, type SignedSwapOffer } from './offer'
import { DIRECT_CLAIM_COST, HANDCASH_SWAP_FEE_PUB, swapFee, takerTotals, type SwapFee, type SwapLegId } from './fee'

export { DIRECT_CLAIM_COST, HANDCASH_SWAP_FEE_PUB, SWAP_FEE_BPS, feeLegOf, swapFee, takerTotals, type SwapFee, type SwapLegId } from './fee'

/**
 * Wallet-to-wallet settlement of a direct swap offer: two hash-locked
 * outputs opened by one secret.
 *
 * The taker picks the secret and locks what it pays on the maker's wanted
 * chain first, for a long time (T1). The maker, once that lock is buried,
 * locks what it gives on the other chain for a shorter time (T2). The taker
 * claims the maker's lock with the secret, which puts the secret on that
 * chain; the maker reads it there (or from the taker's courtesy message) and
 * claims the taker's lock. Whoever's lock is not claimed in time takes it
 * back. Nobody holds anyone's coins at any point.
 *
 * Neither wallet has to be online while the other acts (terms v2). The
 * taker derives the maker's swap key itself (BRC-42, counterparty = the
 * maker), so it sends the take and locks at once; the maker judges the take
 * whenever it next comes online, against the moment it was made and the
 * block the taker's lock landed in, not against its own clock. A maker
 * online about once a day settles every take; one that never answers costs
 * the taker only time, at T1. An offer may be filled in parts: the maker
 * funds takes in the order they were made until the offer is used up and
 * declines the rest.
 *
 * HandCash's cut is a third output on the leg that pays it (the BSV leg when
 * there is one, else the maker's), opened by the same secret: it is claimable
 * only once the swap has happened, and returns to its payer if the swap does
 * not. The taker bears it.
 */

export const SWAP_SETTLE_BOX = 'swap-settle'
/** Per-swap claim / refund key: BRC-42, key id = swap id; counterparty self, but the maker's in v2 is counterparty = the taker. */
export const SWAP_SETTLE_PROTOCOL: [2, string] = [2, 'swap settle']
/** The swap secret is sha256 of this BRC-42 child, so a wallet restored mid-swap still has it. */
export const SWAP_SECRET_PROTOCOL: [2, string] = [2, 'swap secret']


export type SwapTermsVersion = 1 | 2

/**
 * How long the maker's lock (T2) and the taker's (T1) stand after the take,
 * the latest the maker funds (T2 less `makerFundBeforeT2`, so the taker has
 * time to see it buried and claim) and the latest the taker claims (T2 less
 * `takerClaimBeforeT2`, so the claim lands before the maker may refund).
 * v2 leaves the maker about a day to come online and fund, the taker most of
 * a day after that to claim, and the maker a day after the claim to claim.
 */
const WINDOWS = {
  1: { makerLock: 12 * 3600, takerLock: 36 * 3600, makerFundBeforeT2: 8 * 3600, takerClaimBeforeT2: 3 * 3600 },
  2: { makerLock: 48 * 3600, takerLock: 72 * 3600, makerFundBeforeT2: 20 * 3600, takerClaimBeforeT2: 3 * 3600 },
} as const
export const swapWindows = (v: SwapTermsVersion) => WINDOWS[v]
export const MAKER_LOCK_S = WINDOWS[2].makerLock
export const TAKER_LOCK_S = WINDOWS[2].takerLock
/** The latest after the take that the maker may still fund. */
export const MAKER_FUND_WITHIN_S = WINDOWS[2].makerLock - WINDOWS[2].makerFundBeforeT2
/** The taker funds within this of the take, or the swap is dropped with nothing moved. */
export const TAKER_FUND_WITHIN_S = 3600
/** Block times may run this far ahead of the clock (consensus allows two hours). */
const BLOCK_TIME_LEEWAY_S = 2 * 3600
/** A take stamped further in the future than this is refused; v1 also refuses one older than it. */
const TAKE_SKEW_MS = 5 * 60_000
/** A v1 take the maker never answers is dropped after this. */
export const ACCEPT_WAIT_MS = 10 * 60_000

const HEX32 = /^[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/
const PUB = /^0[23][0-9a-f]{64}$/
const UNITS = /^[1-9]\d{0,17}$/
const SECONDS = (ms: number) => Math.floor(ms / 1000)

export type SwapRole = 'taker' | 'maker'

/** What both wallets agree to before anything is locked. */
export type SwapTerms = {
  v: SwapTermsVersion
  /** 16 random bytes, hex: names the swap and its keys. */
  swapId: string
  offer: SignedSwapOffer
  taker: string
  /** Taker pays, in units of `offer.get`. */
  pay: string
  /** Taker receives, in units of `offer.give`, before any fee on the maker's leg. */
  receive: string
  fee: SwapFee | null
  /** sha256 of the secret. */
  hash: string
  takerPub: string
  /** v2: the maker's per-swap key, which the taker derives (BRC-42, counterparty = the maker). v1: from the maker's accept. */
  makerPub?: string
  takenAt: number
  /** Unix seconds. */
  t1: number
  t2: number
}

export type AgreedTerms = SwapTerms & { makerPub: string }

export type SwapLeg = {
  id: SwapLegId
  chain: SwapAsset
  payer: SwapRole
  /** To the counterparty. */
  amount: bigint
  /** To HandCash; 0n when this leg carries no fee. */
  fee: bigint
  locktime: number
}

// ── Fee ───────────────────────────────────────────────────────────────────

export type TakePreview = { pays: bigint; receives: bigint; fee: bigint; feeLeg: SwapLegId | null; makerLockS: number; takerLockS: number }

/** What taking `offer` for `pay` would lock and return, before any key is touched; null when the offer cannot be filled for `pay`. */
export function previewTake(offer: SignedSwapOffer, pay: bigint): TakePreview | null {
  const receive = fillOffer(offer, pay)
  if (receive === null) return null
  const fee = swapFee(offer, pay, receive)
  const totals = takerTotals({ pay: pay.toString(), receive: receive.toString(), fee })
  if (totals.receives <= DIRECT_CLAIM_COST[offer.give]) return null
  return { ...totals, feeLeg: fee?.leg ?? null, makerLockS: MAKER_LOCK_S, takerLockS: TAKER_LOCK_S }
}

// ── Partial fills ─────────────────────────────────────────────────────────

/** Swaps that ended this way gave the offer back its room: nothing of the maker's was ever locked for them. */
const RELEASES_ROOM: ReadonlySet<SettleOutcome> = new Set(['declined', 'expired'])

/** Units of `offer.get` still open: `maxGet` less every take of it the maker has taken on and not released. */
export function offerRemaining(offer: SignedSwapOffer, takes: ReadonlyArray<{ terms: SwapTerms; outcome?: SettleOutcome }>): bigint {
  const used = takes.filter((t) => t.terms.offer.nonce === offer.nonce && !(t.outcome && RELEASES_ROOM.has(t.outcome))).reduce((sum, t) => sum + BigInt(t.terms.pay), 0n)
  const left = BigInt(offer.maxGet) - used
  return left > 0n ? left : 0n
}

/** Whether a take for `pay` still fits what is left of its offer. */
export const takeFits = (offer: SignedSwapOffer, remaining: bigint, pay: bigint): boolean => pay >= BigInt(offer.minGet) && pay <= remaining

export { offerRoom }

/** The maker's own record of an offer it published, as far as judging a take needs it. */
export type OwnOffer = { offer: SignedSwapOffer; state: 'open' | 'taken' | 'cancelled'; cancelledAt?: number }

/**
 * Whether the maker takes on a checked take of `own`: a v1 take only while
 * the offer is open; a v2 take if the offer was not withdrawn before the take
 * was made, and either way only if what is left of the offer still fits it.
 * `usedUp`: no further take fits once this one is taken on.
 */
export function judgeTakeRoom(
  own: OwnOffer | undefined,
  takes: ReadonlyArray<{ terms: SwapTerms; outcome?: SettleOutcome }>,
  terms: SwapTerms,
): { ok: true; left: bigint; usedUp: boolean } | { ok: false; reason: string } {
  if (!own) return { ok: false, reason: 'offer-unknown' }
  if (terms.v === 1 && own.state !== 'open') return { ok: false, reason: `offer-${own.state}` }
  if (terms.v === 2 && own.cancelledAt !== undefined && own.cancelledAt <= terms.takenAt) return { ok: false, reason: 'offer-cancelled' }
  const remaining = offerRemaining(own.offer, takes)
  if (!takeFits(own.offer, remaining, BigInt(terms.pay))) return { ok: false, reason: 'offer-filled' }
  const left = remaining - BigInt(terms.pay)
  return { ok: true, left, usedUp: terms.v === 1 || left < BigInt(own.offer.minGet) }
}

// ── Legs ──────────────────────────────────────────────────────────────────

export function swapLegs(terms: SwapTerms): { taker: SwapLeg; maker: SwapLeg } {
  const fee = terms.fee ? BigInt(terms.fee.amount) : 0n
  const onTaker = terms.fee?.leg === 'taker'
  return {
    taker: { id: 'taker', chain: terms.offer.get, payer: 'taker', amount: BigInt(terms.pay), fee: onTaker ? fee : 0n, locktime: terms.t1 },
    maker: { id: 'maker', chain: terms.offer.give, payer: 'maker', amount: BigInt(terms.receive) - (onTaker ? 0n : fee), fee: onTaker ? 0n : fee, locktime: terms.t2 },
  }
}

export type LegScript = { script: Bytes; scriptPubKey: Bytes; address: string | null; amount: bigint }

/** The outputs that fund `leg`: the swap output to the counterparty and, when the leg carries it, the fee output. */
export function legOutputs(terms: AgreedTerms, legId: SwapLegId, feePub = HANDCASH_SWAP_FEE_PUB): { main: LegScript; fee: LegScript | null } {
  const leg = swapLegs(terms)[legId]
  const payerPub = fromHex(leg.payer === 'taker' ? terms.takerPub : terms.makerPub)
  const payeePub = fromHex(leg.payer === 'taker' ? terms.makerPub : terms.takerPub)
  // v1 BSV refunds were pre-signed by the payee; a v2 BSV lock checks its own refund's nLockTime.
  const base = { hash: fromHex(terms.hash), refundPub: payerPub, locktime: leg.locktime, ...(leg.chain === 'bsv' && terms.v === 1 ? { cosignPub: payeePub } : {}) }
  const build = (t: HtlcTerms, amount: bigint): LegScript => {
    const script = htlcScript(leg.chain, t)
    return { script, ...htlcOutput(leg.chain, script), amount }
  }
  return {
    main: build({ ...base, claimPub: payeePub }, leg.amount),
    fee: leg.fee > 0n ? build({ ...base, claimPub: fromHex(feePub) }, leg.fee) : null,
  }
}

// ── Keys and the secret ───────────────────────────────────────────────────

export const swapSettleKey = (root: PrivateKey, swapId: string): PrivateKey => new KeyDeriver(root).derivePrivateKey(SWAP_SETTLE_PROTOCOL, swapId, 'self')
export const swapSettlePub = (root: PrivateKey, swapId: string): string => swapSettleKey(root, swapId).toPublicKey().toString()

/** This wallet's claim / refund key in a swap: the taker's is counterparty self; a v2 maker's is counterparty = the taker. */
export function settleKeyOf(root: PrivateKey, terms: SwapTerms, role: SwapRole): PrivateKey {
  if (role === 'maker' && terms.v === 2) return new KeyDeriver(root).derivePrivateKey(SWAP_SETTLE_PROTOCOL, terms.swapId, terms.taker)
  return swapSettleKey(root, terms.swapId)
}

/** The v2 maker's per-swap public key, as the taker derives it without asking. */
export const makerSettlePubFor = (takerRoot: PrivateKey, swapId: string, maker: string): string =>
  new KeyDeriver(takerRoot).derivePublicKey(SWAP_SETTLE_PROTOCOL, swapId, maker).toString()

/** The terms with the maker's key, once known: always for v2, after the accept for v1. */
export const agreedTerms = (terms: SwapTerms, acceptedMakerPub?: string): AgreedTerms | null => {
  const makerPub = terms.v === 2 ? terms.makerPub : acceptedMakerPub
  return makerPub ? { ...terms, makerPub } : null
}

export function swapSecret(root: PrivateKey, swapId: string): Bytes {
  const child = new KeyDeriver(root).derivePrivateKey(SWAP_SECRET_PROTOCOL, swapId, 'self')
  return Uint8Array.from(Hash.sha256(child.toArray('be', 32)))
}

export const secretHash = (secret: Bytes): string => Utils.toHex(Hash.sha256(Array.from(secret)))

// ── The take ──────────────────────────────────────────────────────────────

export type TakeRefusal =
  | 'malformed'
  | 'wrong-key'
  | 'offer'
  | 'own-offer'
  | 'out-of-bounds'
  | 'wrong-receive'
  | 'wrong-fee'
  | 'wrong-times'
  | 'stale'
  | 'nothing-left'

/** The terms a taker proposes for paying `pay` into `offer`. */
export function proposeTerms(
  offer: SignedSwapOffer,
  pay: bigint,
  taker: { identityKey: string; root: PrivateKey },
  opts: { now: number; swapId?: string },
): { ok: true; terms: SwapTerms } | { ok: false; reason: TakeRefusal } {
  const checked = verifySwapOffer(offer, opts.now)
  if (!checked.ok) return { ok: false, reason: 'offer' }
  if (offer.maker === taker.identityKey) return { ok: false, reason: 'own-offer' }
  const receive = fillOffer(offer, pay)
  if (receive === null) return { ok: false, reason: 'out-of-bounds' }
  const fee = swapFee(offer, pay, receive)
  const swapId = opts.swapId ?? toHex(crypto.getRandomValues(new Uint8Array(16)))
  const w = WINDOWS[2]
  const terms: SwapTerms = {
    v: 2,
    swapId,
    offer,
    taker: taker.identityKey,
    pay: pay.toString(),
    receive: receive.toString(),
    fee,
    hash: secretHash(swapSecret(taker.root, swapId)),
    takerPub: swapSettlePub(taker.root, swapId),
    makerPub: makerSettlePubFor(taker.root, swapId, offer.maker),
    takenAt: opts.now,
    t1: SECONDS(opts.now) + w.takerLock,
    t2: SECONDS(opts.now) + w.makerLock,
  }
  if (takerTotals(terms).receives <= DIRECT_CLAIM_COST[offer.give]) return { ok: false, reason: 'nothing-left' }
  return { ok: true, terms }
}

function wellFormedTerms(t: Partial<SwapTerms>): t is SwapTerms {
  return (
    (t.v === 1 || (t.v === 2 && typeof t.makerPub === 'string' && PUB.test(t.makerPub))) &&
    typeof t.swapId === 'string' &&
    HEX32.test(t.swapId) &&
    typeof t.offer === 'object' &&
    t.offer !== null &&
    typeof t.taker === 'string' &&
    PUB.test(t.taker) &&
    UNITS.test(String(t.pay)) &&
    UNITS.test(String(t.receive)) &&
    (t.fee === null || (typeof t.fee === 'object' && (t.fee?.leg === 'taker' || t.fee?.leg === 'maker') && UNITS.test(String(t.fee.amount)))) &&
    typeof t.hash === 'string' &&
    HEX64.test(t.hash) &&
    typeof t.takerPub === 'string' &&
    PUB.test(t.takerPub) &&
    Number.isSafeInteger(t.takenAt) &&
    Number.isSafeInteger(t.t1) &&
    Number.isSafeInteger(t.t2)
  )
}

/**
 * Check a take as the maker's wallet must before it locks anything: its own
 * offer, filled at the signed price, the fee as the rule says, and lock
 * times measured from the take. A v1 take must be made just now and the
 * offer stand now. A v2 take is judged as of when it was made, so a maker
 * that was away still honours it: the offer stood then, the take is not from
 * the future, there is still time to fund, and it names the key this maker
 * derives for it. That the offer was not withdrawn before the take, and has
 * room left, is the caller's.
 */
export function checkTake(
  value: unknown,
  maker: string,
  now: number,
  makerRoot?: PrivateKey,
): { ok: true; terms: SwapTerms } | { ok: false; reason: TakeRefusal } {
  const t = (value && typeof value === 'object' ? value : {}) as Partial<SwapTerms>
  if (!wellFormedTerms(t)) return { ok: false, reason: 'malformed' }
  const w = WINDOWS[t.v]
  const checked = verifySwapOffer(t.offer, t.v === 2 ? t.takenAt : now)
  if (!checked.ok) return { ok: false, reason: 'offer' }
  if (t.offer.maker !== maker) return { ok: false, reason: 'offer' }
  if (t.taker === maker) return { ok: false, reason: 'own-offer' }
  const pay = BigInt(t.pay)
  const receive = fillOffer(t.offer, pay)
  if (receive === null) return { ok: false, reason: 'out-of-bounds' }
  if (receive.toString() !== t.receive) return { ok: false, reason: 'wrong-receive' }
  const fee = swapFee(t.offer, pay, receive)
  if (JSON.stringify(fee) !== JSON.stringify(t.fee)) return { ok: false, reason: 'wrong-fee' }
  if (t.v === 1 ? Math.abs(now - t.takenAt) > TAKE_SKEW_MS : t.takenAt > now + TAKE_SKEW_MS) return { ok: false, reason: 'stale' }
  if (t.t1 !== SECONDS(t.takenAt) + w.takerLock || t.t2 !== SECONDS(t.takenAt) + w.makerLock) return { ok: false, reason: 'wrong-times' }
  if (t.v === 2 && SECONDS(now) >= t.t2 - w.makerFundBeforeT2) return { ok: false, reason: 'stale' }
  if (t.v === 2 && makerRoot && settleKeyOf(makerRoot, t, 'maker').toPublicKey().toString() !== t.makerPub) return { ok: false, reason: 'wrong-key' }
  if (takerTotals(t).receives <= DIRECT_CLAIM_COST[t.offer.give]) return { ok: false, reason: 'nothing-left' }
  return { ok: true, terms: t }
}

/**
 * Whether the taker's lock landed too late to be the lock of a take made at
 * `takenAt`: a v2 taker locks within the hour, so a lock in a block from
 * well after that means the take was backdated (to reach a price the maker
 * had since withdrawn). The maker never funds against it; the taker's lock
 * returns to it at T1.
 */
export function takerLockTooLate(terms: SwapTerms, blockTime: number | undefined): boolean {
  if (terms.v !== 2 || blockTime === undefined) return false
  return blockTime > takerLockSeenBy(terms)
}

/** The last moment a taker lock still counts (unix seconds): the taker's window plus block-time leeway. A maker waits for it this long. */
export const takerLockSeenBy = (terms: SwapTerms): number => SECONDS(terms.takenAt) + TAKER_FUND_WITHIN_S + BLOCK_TIME_LEEWAY_S

// ── Messages (box `swap-settle`, sealed to the counterparty) ──────────────

export type SettleMessage =
  | { t: 'take'; terms: SwapTerms }
  | { t: 'accept'; swapId: string; makerPub: string }
  | { t: 'decline'; swapId: string; reason: string }
  /** A BSV leg's payer asks the counterparty to co-sign its refunds before it broadcasts the lock. */
  | { t: 'presign'; swapId: string; leg: SwapLegId; txid: string; refunds: Array<{ vout: number; to: string; value: string }> }
  | { t: 'presigned'; swapId: string; leg: SwapLegId; cosigs: string[] }
  /** A leg is locked: the transaction, and on BSV its Atomic BEEF so the counterparty verifies it without an indexer. */
  | { t: 'funded'; swapId: string; leg: SwapLegId; txid: string; main: number; fee?: number; beef?: string }
  /** The taker hands the maker the secret once it has claimed: a courtesy; the maker also reads it from the chain. */
  | { t: 'secret'; swapId: string; secret: string }
  /** Nothing was locked and nothing will be. */
  | { t: 'abort'; swapId: string; reason: string }

const isLeg = (v: unknown): v is SwapLegId => v === 'taker' || v === 'maker'
const isVout = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0

/** A message read from the box, shape-checked; null for anything else. Content is still judged by the swap's own state. */
export function parseSettleMessage(raw: unknown): SettleMessage | null {
  let m: Record<string, unknown>
  try {
    m = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>
  } catch {
    return null
  }
  if (!m || typeof m !== 'object') return null
  if (m.t === 'take') return typeof m.terms === 'object' && m.terms !== null ? { t: 'take', terms: m.terms as SwapTerms } : null
  if (typeof m.swapId !== 'string' || !HEX32.test(m.swapId)) return null
  const swapId = m.swapId
  switch (m.t) {
    case 'accept':
      return typeof m.makerPub === 'string' && PUB.test(m.makerPub) ? { t: 'accept', swapId, makerPub: m.makerPub } : null
    case 'decline':
    case 'abort':
      return { t: m.t, swapId, reason: String(m.reason ?? '').slice(0, 200) }
    case 'presign': {
      if (!isLeg(m.leg) || typeof m.txid !== 'string' || !HEX64.test(m.txid) || !Array.isArray(m.refunds) || m.refunds.length < 1 || m.refunds.length > 2) return null
      const refunds = (m.refunds as Array<Record<string, unknown>>).map((r) => ({ vout: r?.vout, to: r?.to, value: r?.value }))
      if (!refunds.every((r) => isVout(r.vout) && typeof r.to === 'string' && /^(?:[0-9a-f]{2}){1,64}$/.test(r.to) && UNITS.test(String(r.value)))) return null
      return { t: 'presign', swapId, leg: m.leg, txid: m.txid, refunds: refunds as Array<{ vout: number; to: string; value: string }> }
    }
    case 'presigned':
      if (!isLeg(m.leg) || !Array.isArray(m.cosigs) || m.cosigs.length < 1 || m.cosigs.length > 2 || !m.cosigs.every((s) => typeof s === 'string' && /^[0-9a-f]{18,146}$/.test(s))) return null
      return { t: 'presigned', swapId, leg: m.leg, cosigs: m.cosigs as string[] }
    case 'funded':
      if (!isLeg(m.leg) || typeof m.txid !== 'string' || !HEX64.test(m.txid) || !isVout(m.main)) return null
      if (m.fee !== undefined && !isVout(m.fee)) return null
      if (m.beef !== undefined && (typeof m.beef !== 'string' || m.beef.length > 2_000_000)) return null
      return { t: 'funded', swapId, leg: m.leg, txid: m.txid, main: m.main, ...(m.fee !== undefined ? { fee: m.fee as number } : {}), ...(m.beef !== undefined ? { beef: m.beef as string } : {}) }
    case 'secret':
      return typeof m.secret === 'string' && HEX64.test(m.secret) ? { t: 'secret', swapId, secret: m.secret } : null
    default:
      return null
  }
}

// ── What to do next ───────────────────────────────────────────────────────

/** What a wallet knows of one leg, from its own journal and the chain. */
export type LegFacts = {
  /** The lock is broadcast (own leg) or announced and checked against the terms (peer leg). */
  funded: boolean
  /** Buried to the chain's proof depth and proven by this wallet. */
  buried: boolean
  /** This wallet's claim of it is broadcast. */
  claimed: boolean
  /** The payer took it back. */
  refunded: boolean
  /** BSV payer: the counterparty's refund co-signatures are in hand. */
  presigned?: boolean
  /** Own leg: its fee output is still unspent (HandCash has not claimed it). */
  feeUnspent?: boolean
  /** Own leg: the lock is proven never to reach the chain (a coin it spent went elsewhere). */
  unsent?: boolean
  /** Own leg: a lock was begun and may be signed, not yet recorded as funded. Resolved by `fund` before anything ends the swap. */
  started?: boolean
}

export type SettleFacts = {
  role: SwapRole
  /** Unix ms. */
  now: number
  accepted: boolean
  declined: boolean
  /** Maker: the secret is known (from the courtesy message or the chain). The taker always knows it. */
  secretKnown: boolean
  own: LegFacts
  peer: LegFacts
  /** Own leg is on BSV, so its refund needs the counterparty's co-signature before it is funded. */
  ownOnBsv: boolean
}

/**
 * `swapped`: both claimed. `refunded`: each payer took its lock back.
 * `declined` / `expired`: ended before this wallet locked anything.
 * `missed`: the maker's wallet was away past T1, so the taker holds both sides.
 * `unsent`: this wallet's lock never reached the chain, so nothing was locked.
 */
export type SettleOutcome = 'swapped' | 'refunded' | 'declined' | 'expired' | 'missed' | 'unsent'

export type SettleWait = 'accept' | 'presign' | 'peer-funding' | 'peer-burial' | 'secret' | 'locktime'

export type SettleStep =
  | { kind: 'wait'; for: SettleWait; until?: number }
  | { kind: 'request-presign' }
  | { kind: 'fund' }
  | { kind: 'claim' }
  | { kind: 'refund' }
  /** The swap happened but HandCash never claimed its fee output: it returns to its payer at the lock time. */
  | { kind: 'refund-fee' }
  | { kind: 'done'; outcome: SettleOutcome }

/**
 * The one next step for a swap, from facts alone. Every path that leaves
 * coins locked ends in a claim or a refund; every refusal before a lock ends
 * with nothing moved.
 */
export function nextSettleStep(terms: SwapTerms, f: SettleFacts): SettleStep {
  const now = f.now
  const nowS = SECONDS(now)
  const w = WINDOWS[terms.v]
  const ownLock = f.role === 'taker' ? terms.t1 : terms.t2
  const refundOrWait = (): SettleStep => (f.own.refunded ? { kind: 'done', outcome: 'refunded' } : nowS >= ownLock ? { kind: 'refund' } : { kind: 'wait', for: 'locktime', until: ownLock * 1000 })

  if (f.peer.claimed) {
    if (!f.own.feeUnspent) return { kind: 'done', outcome: 'swapped' }
    return nowS >= ownLock ? { kind: 'refund-fee' } : { kind: 'wait', for: 'locktime', until: ownLock * 1000 }
  }
  // Nothing of this wallet's is locked: no refund to wait for, and no claim against a counterparty it never paid.
  if (f.own.funded && f.own.unsent) return { kind: 'done', outcome: 'unsent' }
  // A lock that may be signed is found or ruled out before a decline or an expiry can close the swap over it.
  if (f.own.started && !f.own.funded) return { kind: 'fund' }
  if (f.declined && !f.own.funded) return { kind: 'done', outcome: 'declined' }

  const presigns = terms.v === 1 && f.ownOnBsv
  if (f.role === 'taker') {
    // v1 waits for the maker's accept, which carries its key; v2 already holds the key and locks at once.
    if (terms.v === 1 && !f.accepted) return now - terms.takenAt > ACCEPT_WAIT_MS ? { kind: 'done', outcome: 'expired' } : { kind: 'wait', for: 'accept' }
    if (!f.own.funded) {
      if (nowS > SECONDS(terms.takenAt) + TAKER_FUND_WITHIN_S) return { kind: 'done', outcome: 'expired' }
      if (presigns && !f.own.presigned) return { kind: 'request-presign' }
      return { kind: 'fund' }
    }
    const claimBy = terms.t2 - w.takerClaimBeforeT2
    if (nowS >= claimBy) return refundOrWait()
    // Declined after this wallet locked: the maker will not fund, so the lock only waits out T1.
    if (!f.peer.funded && f.declined) return refundOrWait()
    if (!f.peer.funded) return { kind: 'wait', for: 'peer-funding', until: (terms.t2 - w.makerFundBeforeT2) * 1000 }
    if (!f.peer.buried) return { kind: 'wait', for: 'peer-burial', until: claimBy * 1000 }
    return { kind: 'claim' }
  }

  // Maker.
  if (!f.own.funded) {
    const fundBy = terms.t2 - w.makerFundBeforeT2
    if (nowS >= fundBy) return { kind: 'done', outcome: 'expired' }
    // The taker stops trying to lock at TAKER_FUND_WITHIN_S; the maker waits as long as a lock that late may take to be seen (`takerLockTooLate`).
    if (!f.peer.funded) return nowS > takerLockSeenBy(terms) ? { kind: 'done', outcome: 'expired' } : { kind: 'wait', for: 'peer-funding', until: takerLockSeenBy(terms) * 1000 }
    if (!f.peer.buried) return { kind: 'wait', for: 'peer-burial', until: fundBy * 1000 }
    if (presigns && !f.own.presigned) return { kind: 'request-presign' }
    return { kind: 'fund' }
  }
  // The secret is public only once the taker claimed this wallet's lock: claim theirs until they take it back.
  // Missed: the taker claimed this wallet's lock and took its own back before this wallet claimed it.
  if (f.secretKnown) return f.peer.refunded ? { kind: 'done', outcome: 'missed' } : { kind: 'claim' }
  if (f.own.refunded) return { kind: 'done', outcome: 'refunded' }
  return nowS >= ownLock ? { kind: 'refund' } : { kind: 'wait', for: 'secret', until: ownLock * 1000 }
}
