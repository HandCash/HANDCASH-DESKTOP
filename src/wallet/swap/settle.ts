import { Hash, KeyDeriver, PrivateKey, Utils } from '@bsv/sdk'
import { fromHex, toHex, type Bytes } from '../ltc/litecoin'
import type { SwapAsset } from './assets'
import { htlcOutput, htlcScript, type HtlcTerms } from './htlc'
import { fillOffer, verifySwapOffer, type SignedSwapOffer } from './offer'
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
 * HandCash's cut is a third output on the leg that pays it (the BSV leg when
 * there is one, else the maker's), opened by the same secret: it is claimable
 * only once the swap has happened, and returns to its payer if the swap does
 * not. The taker bears it.
 */

export const SWAP_SETTLE_BOX = 'swap-settle'
/** Per-swap claim / refund / co-sign key: BRC-42, key id = swap id, counterparty self. */
export const SWAP_SETTLE_PROTOCOL: [2, string] = [2, 'swap settle']
/** The swap secret is sha256 of this BRC-42 child, so a wallet restored mid-swap still has it. */
export const SWAP_SECRET_PROTOCOL: [2, string] = [2, 'swap secret']


/** How long the maker's lock (T2) and the taker's (T1) stand after the take. */
export const MAKER_LOCK_S = 12 * 3600
export const TAKER_LOCK_S = 36 * 3600
/** The taker funds within this of the take, or the swap is dropped with nothing moved. */
export const TAKER_FUND_WITHIN_S = 3600
/** The maker funds no later than T2 less this, so the taker has time to see it buried and claim. */
export const MAKER_FUND_BEFORE_T2_S = 8 * 3600
/** The taker never claims with less than this left before T2: the claim must land before the maker may refund. */
export const TAKER_CLAIM_BEFORE_T2_S = 3 * 3600
/** A take older than this, or from further in the future, is refused. */
const TAKE_SKEW_MS = 5 * 60_000
/** A take the maker never answers is dropped after this. */
export const ACCEPT_WAIT_MS = 10 * 60_000

const HEX32 = /^[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/
const PUB = /^0[23][0-9a-f]{64}$/
const UNITS = /^[1-9]\d{0,17}$/
const SECONDS = (ms: number) => Math.floor(ms / 1000)

export type SwapRole = 'taker' | 'maker'

/** What both wallets agree to before anything is locked. */
export type SwapTerms = {
  v: 1
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
  const base = { hash: fromHex(terms.hash), refundPub: payerPub, locktime: leg.locktime, ...(leg.chain === 'bsv' ? { cosignPub: payeePub } : {}) }
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

export function swapSecret(root: PrivateKey, swapId: string): Bytes {
  const child = new KeyDeriver(root).derivePrivateKey(SWAP_SECRET_PROTOCOL, swapId, 'self')
  return Uint8Array.from(Hash.sha256(child.toArray('be', 32)))
}

export const secretHash = (secret: Bytes): string => Utils.toHex(Hash.sha256(Array.from(secret)))

// ── The take ──────────────────────────────────────────────────────────────

export type TakeRefusal =
  | 'malformed'
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
  const terms: SwapTerms = {
    v: 1,
    swapId,
    offer,
    taker: taker.identityKey,
    pay: pay.toString(),
    receive: receive.toString(),
    fee,
    hash: secretHash(swapSecret(taker.root, swapId)),
    takerPub: swapSettlePub(taker.root, swapId),
    takenAt: opts.now,
    t1: SECONDS(opts.now) + TAKER_LOCK_S,
    t2: SECONDS(opts.now) + MAKER_LOCK_S,
  }
  if (takerTotals(terms).receives <= DIRECT_CLAIM_COST[offer.give]) return { ok: false, reason: 'nothing-left' }
  return { ok: true, terms }
}

function wellFormedTerms(t: Partial<SwapTerms>): t is SwapTerms {
  return (
    t.v === 1 &&
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
 * offer, still standing, filled at the signed price, the fee as the rule
 * says, and lock times measured from a take made just now.
 */
export function checkTake(value: unknown, maker: string, now: number): { ok: true; terms: SwapTerms } | { ok: false; reason: TakeRefusal } {
  const t = (value && typeof value === 'object' ? value : {}) as Partial<SwapTerms>
  if (!wellFormedTerms(t)) return { ok: false, reason: 'malformed' }
  const checked = verifySwapOffer(t.offer, now)
  if (!checked.ok) return { ok: false, reason: 'offer' }
  if (t.offer.maker !== maker) return { ok: false, reason: 'offer' }
  if (t.taker === maker) return { ok: false, reason: 'own-offer' }
  const pay = BigInt(t.pay)
  const receive = fillOffer(t.offer, pay)
  if (receive === null) return { ok: false, reason: 'out-of-bounds' }
  if (receive.toString() !== t.receive) return { ok: false, reason: 'wrong-receive' }
  const fee = swapFee(t.offer, pay, receive)
  if (JSON.stringify(fee) !== JSON.stringify(t.fee)) return { ok: false, reason: 'wrong-fee' }
  if (Math.abs(now - t.takenAt) > TAKE_SKEW_MS) return { ok: false, reason: 'stale' }
  if (t.t1 !== SECONDS(t.takenAt) + TAKER_LOCK_S || t.t2 !== SECONDS(t.takenAt) + MAKER_LOCK_S) return { ok: false, reason: 'wrong-times' }
  if (takerTotals(t).receives <= DIRECT_CLAIM_COST[t.offer.give]) return { ok: false, reason: 'nothing-left' }
  return { ok: true, terms: t }
}

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
 */
export type SettleOutcome = 'swapped' | 'refunded' | 'declined' | 'expired' | 'missed'

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
  const ownLock = f.role === 'taker' ? terms.t1 : terms.t2
  const refundOrWait = (): SettleStep => (f.own.refunded ? { kind: 'done', outcome: 'refunded' } : nowS >= ownLock ? { kind: 'refund' } : { kind: 'wait', for: 'locktime', until: ownLock * 1000 })

  if (f.peer.claimed) {
    if (!f.own.feeUnspent) return { kind: 'done', outcome: 'swapped' }
    return nowS >= ownLock ? { kind: 'refund-fee' } : { kind: 'wait', for: 'locktime', until: ownLock * 1000 }
  }
  if (f.declined && !f.own.funded) return { kind: 'done', outcome: 'declined' }

  if (f.role === 'taker') {
    if (!f.accepted) return now - terms.takenAt > ACCEPT_WAIT_MS ? { kind: 'done', outcome: 'expired' } : { kind: 'wait', for: 'accept' }
    if (!f.own.funded) {
      if (nowS > SECONDS(terms.takenAt) + TAKER_FUND_WITHIN_S) return { kind: 'done', outcome: 'expired' }
      if (f.ownOnBsv && !f.own.presigned) return { kind: 'request-presign' }
      return { kind: 'fund' }
    }
    const claimBy = terms.t2 - TAKER_CLAIM_BEFORE_T2_S
    if (nowS >= claimBy) return refundOrWait()
    if (!f.peer.funded) return { kind: 'wait', for: 'peer-funding', until: (terms.t2 - MAKER_FUND_BEFORE_T2_S) * 1000 }
    if (!f.peer.buried) return { kind: 'wait', for: 'peer-burial', until: claimBy * 1000 }
    return { kind: 'claim' }
  }

  // Maker.
  if (!f.own.funded) {
    const fundBy = terms.t2 - MAKER_FUND_BEFORE_T2_S
    if (nowS >= fundBy) return { kind: 'done', outcome: 'expired' }
    if (!f.peer.funded) return nowS > SECONDS(terms.takenAt) + TAKER_FUND_WITHIN_S ? { kind: 'done', outcome: 'expired' } : { kind: 'wait', for: 'peer-funding' }
    if (!f.peer.buried) return { kind: 'wait', for: 'peer-burial', until: fundBy * 1000 }
    if (f.ownOnBsv && !f.own.presigned) return { kind: 'request-presign' }
    return { kind: 'fund' }
  }
  // The secret is public only once the taker claimed this wallet's lock: claim theirs until they take it back.
  // Missed: the taker claimed this wallet's lock and took its own back before this wallet claimed it.
  if (f.secretKnown) return f.peer.refunded ? { kind: 'done', outcome: 'missed' } : { kind: 'claim' }
  if (f.own.refunded) return { kind: 'done', outcome: 'refunded' }
  return nowS >= ownLock ? { kind: 'refund' } : { kind: 'wait', for: 'secret', until: ownLock * 1000 }
}
