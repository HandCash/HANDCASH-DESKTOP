import { PrivateKey } from '@bsv/sdk'
import { createActor } from 'xstate'
import { swapSettleMachine, type SwapSettleEvent, type SwapSettlePhase } from '../../machines/swapSettleMachine'
import { fromHex, toHex } from '../ltc/litecoin'
import type { LockSighting } from '../coins/coinWallet'
import { SWAP_ASSET_INFO, unitsToDecimal } from './assets'
import { followedSwapRecords, refreshSwapRecords } from './exolixSwap'
import type { HtlcCoin } from './htlc'
import {
  abortBsvLock,
  bsvCosignValid,
  bsvRefundValue,
  bsvSelfOutput,
  commitBsvLock,
  cosignBsvRefund,
  leanBsvLockBeef,
  legChainOf,
  prepareBsvLock,
  type LegSpend,
  type StoredClaimTemplate,
} from './legChains'
import type { ClaimTicket } from './claimTower'
import {
  agreedTerms,
  checkTake,
  judgeTakeRoom,
  legOutputs,
  nextSettleStep,
  offerRemaining,
  proposeTerms,
  secretHash,
  settleKeyOf,
  swapLegs,
  swapSecret,
  swapSettleKey,
  swapSettlePub,
  takeFits,
  takerLockTooLate,
  takerTotals,
  type AgreedTerms,
  type LegScript,
  type SettleFacts,
  type SettleMessage,
  type SettleStep,
  type SwapLegId,
  type SwapRole,
  type SwapTerms,
} from './settle'
import type { FeeLockReport } from './feeClaim'
import {
  ackSettleBox,
  bsvLockProvenUnsent,
  claimTowerOrigins,
  journalSwapLock,
  journalSwapLockSpent,
  readSettleBox,
  registerClaimTicket,
  reportFeeLock,
  requireActiveWallet,
  sendSettle,
} from './settlePorts'
import { activeSwaps, markOfferCancelled, putSwap, readSettleState, rememberPublishedOffer, updateSwap, writeSettleState, type SettleRecord } from './settleStore'
import type { SwapOfferDraft } from './offerBook'
import type { SignedSwapOffer } from './offer'
import type { ActiveWallet } from '../session'

/**
 * Carries every wallet-to-wallet swap of the open account to its end. One
 * pass reads box `swap-settle`, then for each swap gathers what this wallet
 * knows (its record, the chain) and takes the one step `nextSettleStep`
 * names. Each step that moves coins is written to the record before it runs
 * and is safe to repeat, so a pass interrupted anywhere resumes cleanly.
 *
 * The maker side answers takes of this account's own published offers
 * without asking: the offer is the maker's standing, signed instruction, and
 * nothing is locked until the taker's lock is buried. Takes that came in
 * while this wallet was away are judged as of when they were made and taken
 * on in that order until the offer is used up; the rest are declined.
 */

const BOX_POLL_MS = 20_000
const TICK_MS = 30_000
/** A presign request the counterparty has not answered is asked again after this. */
const PRESIGN_RETRY_MS = 2 * 60_000
/** A `funded` notice is sent again this often until the counterparty's lock appears (it may have missed one). */
const FUNDED_RETRY_MS = 10 * 60_000
/** A claim watchtower that did not answer is asked again after this. */
const TOWER_RETRY_MS = 10 * 60_000

let boxPolledAt = 0
let tickedAt = 0
let serving = false
/** The account whose swaps were last rebuilt from the custody journal. */
let replayedFor: string | null = null
/** When each swap is next worth a look; a message for it or a forced pass looks sooner. */
const checkAt = new Map<string, number>()
/** What each swap was last logged waiting on this session, so every upload names what a stuck swap waits for. */
const waitLogged = new Map<string, string>()
/** When each swap's counterparty lock was last searched for on chain. */
const lockSearchedAt = new Map<string, number>()
const LOCK_SEARCH_MS = 60_000
/** Swaps whose lock already ran the once-a-session heal for being short. */
const healedShort = new Set<string>()

/** How long a swap waiting on `step` can go unexamined: chain reads are spent only when an answer could change the step. */
function recheckAfter(step: SettleStep): number {
  if (step.kind !== 'wait') return 0
  const until = step.until ? Math.max(0, step.until - Date.now()) : Infinity
  const every = { accept: 30_000, presign: 30_000, 'peer-funding': 60_000, 'peer-burial': 60_000, secret: 2 * 60_000, locktime: 10 * 60_000 }[step.for]
  return Math.min(every, until)
}

const log = (swapId: string, text: string) => console.info(`[swap-settle] ${swapId.slice(0, 8)} ${text}`)
const warn = (swapId: string, text: string) => console.warn(`[swap-settle] ${swapId.slice(0, 8)} ${text}`)
const rootOf = (active: ActiveWallet) => PrivateKey.fromHex(active.rootKeyHex)
const ownLegId = (r: SettleRecord): SwapLegId => r.role
const peerLegId = (r: SettleRecord): SwapLegId => (r.role === 'taker' ? 'maker' : 'taker')
const agreedOf = (r: SettleRecord): AgreedTerms | null => agreedTerms(r.terms, r.makerPub)
const keyOf = (active: ActiveWallet, r: SettleRecord) => settleKeyOf(rootOf(active), r.terms, r.role)
const recipeTerms = (r: SettleRecord) => JSON.stringify(agreedOf(r))

/** The swap's chart, restored to the phase its record holds; a step runs only if the chart takes its event. */
function chart(r: SettleRecord) {
  const phase = r.phase ?? 'negotiating'
  const actor = createActor(swapSettleMachine, { snapshot: swapSettleMachine.resolveState({ value: phase, context: undefined }) }).start()
  if (phase === 'locking' && r.own.funding) actor.send({ type: 'OK' })
  if (phase === 'claiming' || phase === 'refunding') actor.send({ type: 'FAIL', error: 'interrupted' })
  return {
    /** Send `event`; false (and nothing sent) when the chart refuses it. */
    take(event: SwapSettleEvent): boolean {
      if (!actor.getSnapshot().can(event)) return false
      actor.send(event)
      return true
    },
    phase: () => actor.getSnapshot().value as SwapSettlePhase,
    stop: () => actor.stop(),
  }
}

const eventOf = (step: Exclude<SettleStep, { kind: 'wait' }>): SwapSettleEvent => {
  switch (step.kind) {
    case 'request-presign':
      return { type: 'PRESIGN' }
    case 'fund':
      return { type: 'FUND' }
    case 'claim':
      return { type: 'CLAIM' }
    case 'refund':
      return { type: 'REFUND' }
    case 'refund-fee':
      return { type: 'REFUND_FEE' }
    case 'done':
      return { type: 'DONE', outcome: step.outcome }
  }
}

// ── Taking an offer ───────────────────────────────────────────────────────

/**
 * Propose the terms of taking `offer` for `pay`, record them and send the
 * take, then lock at once: the maker need not be online, and judges the take
 * when it next is. If it declines (the offer was used up first), the lock
 * returns at T1.
 */
/**
 * How much of each offer this wallet's own takes still hold: every take not
 * ended `declined` or `expired`. A take locks at once, so a second take of an
 * offer the first already fills would lock coins the maker can only decline.
 */
export function ownTakenOf(): ReadonlyMap<string, bigint> {
  const taken = new Map<string, bigint>()
  for (const s of Object.values(readSettleState().swaps)) {
    if (s.role !== 'taker' || s.outcome === 'declined' || s.outcome === 'expired') continue
    const nonce = s.terms.offer.nonce
    taken.set(nonce, (taken.get(nonce) ?? 0n) + BigInt(s.terms.pay))
  }
  return taken
}

export async function takeSwapOffer(offer: SignedSwapOffer, pay: bigint): Promise<SettleRecord> {
  const active = requireActiveWallet()
  const mine = Object.values(readSettleState().swaps).filter((s) => s.role === 'taker' && s.terms.offer.nonce === offer.nonce)
  const left = offerRemaining(offer, mine)
  if (!takeFits(offer, left, pay)) {
    throw new Error(
      left < BigInt(offer.minGet)
        ? 'You already took this offer. Your swap is in progress above.'
        : `You already took part of this offer; at most ${unitsToDecimal(offer.get, left)} ${SWAP_ASSET_INFO[offer.get].ticker} of it is left.`,
    )
  }
  const proposed = proposeTerms(offer, pay, { identityKey: active.identityKey.toLowerCase(), root: rootOf(active) }, { now: Date.now() })
  if (!proposed.ok) throw new Error(`This offer cannot be taken (${proposed.reason}).`)
  const terms = proposed.terms
  if (await canLock('taker', terms)) throw new Error(`Not enough ${SWAP_ASSET_INFO[offer.get].ticker} to lock for this swap.`)
  const now = Date.now()
  const record: SettleRecord = { v: 1, role: 'taker', counterparty: offer.maker, terms, own: {}, peer: {}, waiting: { for: 'peer-funding' }, createdAt: now, updatedAt: now }
  putSwap(record)
  try {
    await sendSettle(active, offer.maker, { t: 'take', terms })
  } catch (err) {
    const state = readSettleState()
    delete state.swaps[terms.swapId]
    writeSettleState(state)
    throw err
  }
  const { pays, receives } = takerTotals(terms)
  log(terms.swapId, `take sent: ${unitsToDecimal(offer.get, pays)} ${SWAP_ASSET_INFO[offer.get].ticker} for ${unitsToDecimal(offer.give, receives)} ${SWAP_ASSET_INFO[offer.give].ticker}`)
  void serveSwapSettle({ force: true })
  return record
}

/** Publish an offer as the open account, remembered so a take of it is answered. */
export async function publishOwnSwapOffer(draft: SwapOfferDraft): Promise<SignedSwapOffer> {
  const active = requireActiveWallet()
  const { publicMessageboxBase } = await import('../messageTransport')
  const { publishSwapOffer } = await import('./offerBook')
  const offer = await publishSwapOffer(draft, { rootKeyHex: active.rootKeyHex, messagebox: publicMessageboxBase() })
  rememberPublishedOffer(offer)
  return offer
}

/** Withdraw one of the open account's offers; a take arriving after this is declined. */
export async function cancelOwnSwapOffer(nonce: string): Promise<void> {
  const active = requireActiveWallet()
  markOfferCancelled(nonce)
  const { cancelSwapOffer } = await import('./offerBook')
  await cancelSwapOffer(nonce, { rootKeyHex: active.rootKeyHex })
}

// ── Box ───────────────────────────────────────────────────────────────────

/** Whether this wallet can lock its leg as `role`, counting what it already promised to swaps it has not locked yet. */
/** Whether this wallet can lock its leg of `terms` beside every swap it has promised and not yet locked. BSV reads the live balance: a cached one accepted a take the wallet could not fund. */
async function canLock(role: SwapRole, terms: SwapTerms): Promise<string | null> {
  const leg = swapLegs(terms)[role]
  const promised = activeSwaps()
    .filter((r) => r.terms.swapId !== terms.swapId && !r.own.funding && !r.outcome && swapLegs(r.terms)[r.role].chain === leg.chain)
    .reduce((sum, r) => sum + swapLegs(r.terms)[r.role].amount + swapLegs(r.terms)[r.role].fee, 0n)
  const units = leg.amount + leg.fee + promised
  try {
    if (leg.chain === 'bsv') {
      const { assertSendableBalanceForReview } = await import('../sendPayment')
      await assertSendableBalanceForReview(Number(units), { fresh: true })
      return null
    }
    const { coinWalletOf } = await import('../coinMethods')
    const spendable = BigInt((await coinWalletOf(leg.chain)).readBalance().spendable)
    return spendable >= units ? null : 'insufficient'
  } catch {
    return 'insufficient'
  }
}

/**
 * A take of one of this account's offers, taken on exactly once if it fits:
 * v1 while the offer stands now; v2 if the offer stood when the take was
 * made and still has room for it. The listing is withdrawn once no take
 * fits what is left, and otherwise told how much is gone.
 */
async function intakeTake(active: ActiveWallet, sender: string, raw: SwapTerms): Promise<void> {
  const self = active.identityKey.toLowerCase()
  const checked = checkTake(raw, self, Date.now(), rootOf(active))
  const swapId = typeof raw?.swapId === 'string' ? raw.swapId : ''
  const decline = (reason: string) => (swapId ? sendSettle(active, sender, { t: 'decline', swapId, reason }).catch(() => {}) : Promise.resolve())
  if (!checked.ok) {
    warn(swapId || '????????', `take refused (${checked.reason})`)
    return decline(checked.reason)
  }
  const terms = checked.terms
  if (terms.taker !== sender) return decline('sender')
  const state = readSettleState()
  if (state.swaps[terms.swapId]) return
  const published = state.offers[terms.offer.nonce]
  const room = judgeTakeRoom(published, Object.values(state.swaps), terms)
  if (!room.ok) {
    warn(terms.swapId, `take refused (${room.reason})`)
    return decline(room.reason)
  }
  const short = await canLock('maker', terms)
  if (short) {
    warn(terms.swapId, `take refused (${short})`)
    return decline(short)
  }
  const now = Date.now()
  const makerPub = terms.v === 2 ? terms.makerPub! : swapSettlePub(rootOf(active), terms.swapId)
  const record: SettleRecord = {
    v: 1,
    role: 'maker',
    counterparty: sender,
    terms,
    makerPub,
    accepted: true,
    own: {},
    peer: {},
    waiting: { for: 'peer-funding' },
    createdAt: now,
    updatedAt: now,
  }
  state.swaps[terms.swapId] = record
  const { left, usedUp } = room
  if (usedUp && published!.state === 'open') state.offers[terms.offer.nonce] = { ...published!, state: 'taken', swapId: terms.swapId }
  writeSettleState(state)
  await sendSettle(active, sender, { t: 'accept', swapId: terms.swapId, makerPub })
  log(terms.swapId, `take accepted${left > 0n && !usedUp ? ` (${left} of the offer left)` : ''}`)
  void updateListing(active, published!.offer, usedUp, BigInt(published!.offer.maxGet) - left).catch((err: unknown) =>
    warn(terms.swapId, `listing update deferred — ${err instanceof Error ? err.message : String(err)}`),
  )
}

/** Withdraw a used-up offer from the book, or tell it how much of a part-filled one is gone. */
async function updateListing(active: ActiveWallet, offer: SignedSwapOffer, usedUp: boolean, filled: bigint): Promise<void> {
  const { cancelSwapOffer, reportSwapOfferFilled } = await import('./offerBook')
  if (usedUp) return cancelSwapOffer(offer.nonce, { rootKeyHex: active.rootKeyHex })
  const reported = readSettleState().offers[offer.nonce]?.filledReported
  if (reported && BigInt(reported) >= filled) return
  await reportSwapOfferFilled(offer.nonce, filled, { rootKeyHex: active.rootKeyHex })
  const state = readSettleState()
  const held = state.offers[offer.nonce]
  if (held) {
    held.filledReported = filled.toString()
    writeSettleState(state)
  }
}

/** The counterparty co-signs this wallet's refunds of a BSV lock it is about to broadcast. */
async function intakePresign(active: ActiveWallet, r: SettleRecord, m: Extract<SettleMessage, { t: 'presign' }>): Promise<void> {
  const agreed = agreedOf(r)
  if (!agreed || agreed.v !== 1 || m.leg !== peerLegId(r)) return
  const leg = swapLegs(agreed)[m.leg]
  if (leg.chain !== 'bsv') return
  const outs = legOutputs(agreed, m.leg)
  const locks = [outs.main, ...(outs.fee ? [outs.fee] : [])]
  if (m.refunds.length !== locks.length) return
  const key = swapSettleKey(rootOf(active), agreed.swapId)
  const cosigs = m.refunds.map((refund, i) => {
    const lock = locks[i]!
    const coin: HtlcCoin = { txid: m.txid, vout: refund.vout, amount: lock.amount, script: lock.script }
    return cosignBsvRefund(coin, fromHex(refund.to), BigInt(refund.value), leg.locktime, key)
  })
  await sendSettle(active, r.counterparty, { t: 'presigned', swapId: r.terms.swapId, leg: m.leg, cosigs })
  log(r.terms.swapId, `co-signed ${cosigs.length} refund(s) of the ${m.leg} lock`)
}

function intakePresigned(r: SettleRecord, m: Extract<SettleMessage, { t: 'presigned' }>): void {
  const agreed = agreedOf(r)
  const refunds = r.own.refunds
  const prepared = r.own.prepared
  if (!agreed || m.leg !== ownLegId(r) || !refunds || !prepared || m.cosigs.length !== refunds.length) return
  const outs = legOutputs(agreed, m.leg)
  const locks = [outs.main, ...(outs.fee ? [outs.fee] : [])]
  const cosignPub = fromHex(r.role === 'taker' ? agreed.makerPub : agreed.takerPub)
  const locktime = swapLegs(agreed)[m.leg].locktime
  const valid = refunds.every((refund, i) =>
    bsvCosignValid({ txid: prepared.txid, vout: refund.vout, amount: locks[i]!.amount, script: locks[i]!.script }, fromHex(refund.to), BigInt(refund.value), locktime, cosignPub, m.cosigs[i]!),
  )
  if (!valid) {
    warn(r.terms.swapId, 'refund co-signatures do not verify; the lock stays unbroadcast')
    return
  }
  updateSwap(r.terms.swapId, (rec) => {
    rec.own.refunds = rec.own.refunds!.map((refund, i) => ({ ...refund, cosig: m.cosigs[i]! }))
    return rec
  })
  log(r.terms.swapId, 'refunds co-signed')
}

async function intakeMessage(active: ActiveWallet, sender: string, m: SettleMessage): Promise<void> {
  if (m.t === 'take') return intakeTake(active, sender, m.terms)
  const r = readSettleState().swaps[m.swapId]
  if (!r || r.counterparty !== sender) return
  switch (m.t) {
    case 'accept':
      if (r.role !== 'taker' || r.accepted || r.declined) return
      // v2 already holds the maker's key; an accept naming another is ignored.
      if (r.terms.v === 2 && m.makerPub !== r.terms.makerPub) return
      updateSwap(m.swapId, (rec) => ({ ...rec, accepted: true, ...(rec.terms.v === 1 ? { makerPub: m.makerPub } : {}) }))
      log(m.swapId, 'maker accepted')
      return
    case 'decline':
    case 'abort':
      if (r.own.funding || r.own.prepared) {
        // A v2 taker locks before the maker has judged the take; a decline then means its lock only waits out T1.
        if (r.terms.v === 2 && r.role === 'taker' && !r.declined) updateSwap(m.swapId, (rec) => ({ ...rec, declined: m.reason || m.t }))
        warn(m.swapId, `${m.t} after this wallet locked (${m.reason}); settling by the chain`)
        return
      }
      updateSwap(m.swapId, (rec) => ({ ...rec, declined: m.reason || m.t }))
      log(m.swapId, `${m.t}: ${m.reason}`)
      return
    case 'presign':
      return intakePresign(active, r, m)
    case 'presigned':
      return intakePresigned(r, m)
    case 'funded':
      if (m.leg !== peerLegId(r) || r.peer.funding) return
      updateSwap(m.swapId, (rec) => ({ ...rec, peer: { ...rec.peer, funding: { txid: m.txid, main: m.main, ...(m.fee !== undefined ? { fee: m.fee } : {}), ...(m.beef ? { beef: m.beef } : {}) } } }))
      log(m.swapId, `counterparty locked ${m.txid.slice(0, 12)}`)
      return
    case 'secret':
      if (r.role !== 'maker' || r.secret || secretHash(fromHex(m.secret)) !== r.terms.hash) return
      updateSwap(m.swapId, (rec) => ({ ...rec, secret: m.secret }))
      log(m.swapId, 'secret received')
      return
  }
}

async function serveBox(active: ActiveWallet): Promise<void> {
  const inbound = await readSettleBox(active)
  if (!inbound) return
  const acks: string[] = []
  // Takes first, in the order they were made (they share what is left of an offer), so every later message finds its swap.
  const takenAt = (m: (typeof inbound)[number]['message']) => (m?.t === 'take' && Number.isSafeInteger(m.terms?.takenAt) ? m.terms.takenAt : null)
  const ordered = [...inbound].sort((a, b) => {
    const ta = takenAt(a.message)
    const tb = takenAt(b.message)
    if (ta === null || tb === null) return ta === null ? (tb === null ? 0 : 1) : -1
    return ta - tb
  })
  for (const { messageId, sender, message } of ordered) {
    try {
      if (message) {
        await intakeMessage(active, sender, message)
        checkAt.delete(message.t === 'take' ? message.terms?.swapId : message.swapId)
      }
      acks.push(messageId)
    } catch (err) {
      console.warn(`[swap-settle] message from ${sender.slice(0, 12)}… deferred — ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  await ackSettleBox(active, acks).catch(() => {})
}

// ── Facts ─────────────────────────────────────────────────────────────────

type Gathered = { facts: SettleFacts; ownSpend: LegSpend | null; feeSpend: LegSpend | null; peerSpend: LegSpend | null; peerSighting: LockSighting | null }

async function gather(active: ActiveWallet, r: SettleRecord): Promise<Gathered> {
  const agreed = agreedOf(r)
  const legs = swapLegs(r.terms)
  const own = legs[ownLegId(r)]
  const peer = legs[peerLegId(r)]
  const hash = fromHex(r.terms.hash)
  let ownSpend: LegSpend | null = null
  let feeSpend: LegSpend | null = null
  let peerSpend: LegSpend | null = null
  let peerSighting: LockSighting | null = null
  const nowS = Math.floor(Date.now() / 1000)
  if (agreed && r.own.funding) {
    const outs = legOutputs(agreed, ownLegId(r))
    const chain = await legChainOf(own.chain)
    // Only the maker learns anything from its own lock being spent: the secret, when the taker claims it.
    const mayRefund = nowS >= own.locktime
    if (!r.own.refunded && (r.role === 'maker' ? !r.secret || mayRefund : mayRefund)) {
      ownSpend = await chain.spendOf({ txid: r.own.funding.txid, vout: r.own.funding.main }, outs.main, hash)
    }
    if (outs.fee && r.own.funding.fee !== undefined && !r.own.feeSettled && (r.peer.claimed || mayRefund)) {
      feeSpend = await chain.spendOf({ txid: r.own.funding.txid, vout: r.own.funding.fee }, outs.fee, hash)
    }
  }
  if (agreed && r.peer.funding && !r.peer.refused) {
    const outs = legOutputs(agreed, peerLegId(r))
    const chain = await legChainOf(peer.chain)
    const outpoint = { txid: r.peer.funding.txid, vout: r.peer.funding.main }
    if (!r.peer.buried) peerSighting = await chain.proveLock(outpoint, outs.main, r.peer.funding.beef)
    if (peerSighting?.kind === 'buried' && r.role === 'maker' && !r.own.funding && takerLockTooLate(r.terms, peerSighting.blockTime)) {
      peerSighting = { kind: 'refused', reason: 'late', detail: `the lock landed at ${peerSighting.blockTime}, long after the take` }
    }
    // A maker holding the secret races the taker's refund: see whether it came first.
    if (r.role === 'maker' && r.secret && !r.peer.claimed && nowS >= peer.locktime) peerSpend = await chain.spendOf(outpoint, outs.main, hash)
    if (outs.fee && r.peer.funding.fee !== undefined && !r.peer.buried) {
      const fee = await chain.proveLock({ txid: r.peer.funding.txid, vout: r.peer.funding.fee }, outs.fee, r.peer.funding.beef)
      if (fee.kind === 'refused') peerSighting = fee
    }
    if (outs.fee && r.peer.funding.fee === undefined) peerSighting = { kind: 'refused', reason: 'no-fee', detail: 'the lock carries no fee output' }
  }
  const unsent = own.chain === 'bsv' && !!r.own.funding && !r.own.refunded && (await bsvLockProvenUnsent(active, r.own.funding.txid, r.own.prepared?.beef))
  const secretKnown = r.role === 'taker' || !!r.secret || ownSpend?.kind === 'claimed'
  const facts: SettleFacts = {
    role: r.role,
    now: Date.now(),
    accepted: !!r.accepted,
    declined: !!r.declined,
    secretKnown,
    ownOnBsv: own.chain === 'bsv',
    own: {
      funded: !!r.own.funding,
      buried: false,
      claimed: false,
      refunded: !!r.own.refunded || ownSpend?.kind === 'refunded',
      presigned: !!r.own.refunds?.length && r.own.refunds.every((x) => x.cosig),
      feeUnspent: feeSpend?.kind === 'unspent',
      unsent,
      started: !r.own.funding && !!r.own.fundingStartedAt,
    },
    peer: {
      funded: !!r.peer.funding && !r.peer.refused && peerSighting?.kind !== 'refused',
      buried: !!r.peer.buried || peerSighting?.kind === 'buried',
      claimed: !!r.peer.claimed || (peerSpend?.kind === 'claimed' && peerSpend.txid === r.peer.claim?.txid),
      refunded: !!r.peer.refunded || peerSpend?.kind === 'refunded',
    },
  }
  return { facts, ownSpend, feeSpend, peerSpend, peerSighting }
}

/**
 * The counterparty's lock, read off its chain when its `funded` message is
 * missing: the lock's script is fixed by the terms, so a box outage cannot
 * hide a lock that is there. Burial and amount are still proven in `gather`.
 */
async function findPeerLock(r: SettleRecord): Promise<SettleRecord> {
  const agreed = agreedOf(r)
  if (!agreed || r.peer.funding || r.declined || (r.role === 'taker' && !r.own.funding)) return r
  const last = lockSearchedAt.get(r.terms.swapId) ?? 0
  if (Date.now() - last < LOCK_SEARCH_MS) return r
  lockSearchedAt.set(r.terms.swapId, Date.now())
  const outs = legOutputs(agreed, peerLegId(r))
  const chain = await legChainOf(swapLegs(r.terms)[peerLegId(r)].chain)
  const found = await chain.findLock(outs.main, outs.fee).catch((err: unknown) => {
    warn(r.terms.swapId, `lock search deferred — ${err instanceof Error ? err.message : String(err)}`)
    return null
  })
  if (!found) return r
  log(r.terms.swapId, `counterparty lock found on chain ${found.txid.slice(0, 12)}`)
  return updateSwap(r.terms.swapId, (rec) => (rec.peer.funding ? null : { ...rec, peer: { ...rec.peer, funding: found } })) ?? r
}

/** What the chain showed, written back before any step acts on it. */
function recordFacts(r: SettleRecord, g: Gathered): SettleRecord {
  return (
    updateSwap(r.terms.swapId, (rec) => {
      const s = g.peerSighting
      if (s?.kind === 'refused') rec.peer.refused = `${s.reason}: ${s.detail}`
      if (s?.kind === 'buried') {
        rec.peer.buried = true
        delete rec.peer.confirmations
      }
      if (s?.kind === 'confirming') rec.peer.confirmations = { have: s.confirmations, need: s.needed }
      if (g.ownSpend?.kind === 'claimed' && !rec.secret) rec.secret = toHex(g.ownSpend.secret)
      if (g.ownSpend?.kind === 'refunded') rec.own.refunded = true
      if (g.peerSpend?.kind === 'refunded') rec.peer.refunded = true
      if (g.peerSpend?.kind === 'claimed' && g.peerSpend.txid === rec.peer.claim?.txid) rec.peer.claimed = true
      if (g.feeSpend?.kind === 'claimed') rec.own.feeSettled = 'claimed'
      if (g.feeSpend?.kind === 'refunded') rec.own.feeSettled = 'refunded'
      return rec
    }) ?? r
  )
}

/**
 * The fee leg's lock, as HandCash's fee claimer needs it. The payer reports
 * it once funded, the payee once it is buried, so either wallet alone gets
 * it there.
 */
function feeLockReportOf(r: SettleRecord): FeeLockReport | null {
  const agreed = agreedOf(r)
  if (!agreed || !r.terms.fee) return null
  const legId = r.terms.fee.leg
  const funding = legId === ownLegId(r) ? r.own.funding : r.peer.buried && !r.peer.refused ? r.peer.funding : undefined
  if (!funding || funding.fee === undefined) return null
  const leg = swapLegs(agreed)[legId]
  const [payerPub, payeePub] = leg.payer === 'taker' ? [agreed.takerPub, agreed.makerPub] : [agreed.makerPub, agreed.takerPub]
  return { v: agreed.v, chain: leg.chain, txid: funding.txid, vout: funding.fee, mainVout: funding.main, amount: leg.fee.toString(), hash: r.terms.hash, payerPub, payeePub, locktime: leg.locktime }
}

async function reportFee(r: SettleRecord): Promise<void> {
  if (r.feeReportedAt || r.outcome) return
  const report = feeLockReportOf(r)
  if (!report) return
  const taken = await reportFeeLock(report).catch(() => false)
  if (taken) updateSwap(r.terms.swapId, (x) => ({ ...x, feeReportedAt: Date.now() }))
}

// ── Steps ─────────────────────────────────────────────────────────────────

async function requestPresign(active: ActiveWallet, r: SettleRecord): Promise<void> {
  const agreed = agreedOf(r)!
  const outs = legOutputs(agreed, ownLegId(r))
  const locks = [outs.main, ...(outs.fee ? [outs.fee] : [])]
  let rec = r
  if (!rec.own.prepared) {
    const prepared = await prepareBsvLock(locks, r.terms.swapId)
    const refunds = await Promise.all(
      locks.map(async (lock, vout) => {
        const self = await bsvSelfOutput()
        return { vout, to: toHex(self.to), value: bsvRefundValue(lock.amount).toString(), remittance: self.remittance }
      }),
    )
    rec = updateSwap(r.terms.swapId, (x) => ({ ...x, own: { ...x.own, prepared, refunds } })) ?? rec
    log(r.terms.swapId, `lock ${prepared.txid.slice(0, 12)} prepared, asking for refund co-signatures`)
  }
  if (rec.own.presignAskedAt && Date.now() - rec.own.presignAskedAt < PRESIGN_RETRY_MS) return
  await sendSettle(active, r.counterparty, {
    t: 'presign',
    swapId: r.terms.swapId,
    leg: ownLegId(r),
    txid: rec.own.prepared!.txid,
    refunds: rec.own.refunds!.map((x) => ({ vout: x.vout, to: x.to, value: x.value })),
  })
  updateSwap(r.terms.swapId, (x) => ({ ...x, own: { ...x.own, presignAskedAt: Date.now() } }))
}

function journalOwnLocks(active: ActiveWallet, r: SettleRecord, funding: { txid: string; main: number; fee?: number }, outs: { main: LegScript; fee: LegScript | null }): void {
  const chain = swapLegs(r.terms)[ownLegId(r)].chain
  const base = { chain, swapId: r.terms.swapId, role: r.role, terms: recipeTerms(r) }
  const refundOf = (i: number) => {
    const x = r.own.refunds?.[i]
    return x?.cosig ? { refund: { to: x.to, value: x.value, prefix: x.remittance.derivationPrefix, suffix: x.remittance.derivationSuffix, cosig: x.cosig } } : {}
  }
  journalSwapLock(active, `${funding.txid}.${funding.main}`, outs.main.amount, { ...base, side: 'own', ...refundOf(0) })
  if (outs.fee && funding.fee !== undefined) journalSwapLock(active, `${funding.txid}.${funding.fee}`, outs.fee.amount, { ...base, side: 'fee', ...refundOf(1) })
}

async function fund(active: ActiveWallet, r: SettleRecord): Promise<void> {
  const agreed = agreedOf(r)!
  const leg = swapLegs(agreed)[ownLegId(r)]
  const outs = legOutputs(agreed, ownLegId(r))
  let funding: { txid: string; main: number; fee?: number }
  let beef: string | undefined
  if (leg.chain === 'bsv') {
    let prepared = r.own.prepared
    if (!prepared) {
      // v1 prepares while the refunds are co-signed; v2 prepares here and writes it down before it broadcasts.
      if (agreed.v === 1) throw new Error('a v1 BSV lock is broadcast only once its refunds are co-signed')
      prepared = await prepareBsvLock([outs.main, ...(outs.fee ? [outs.fee] : [])], r.terms.swapId)
      const made = prepared
      updateSwap(r.terms.swapId, (x) => ({ ...x, own: { ...x.own, prepared: made } }))
    }
    funding = { txid: prepared.txid, main: 0, ...(outs.fee ? { fee: 1 } : {}) }
    journalOwnLocks(active, r, funding, outs)
    updateSwap(r.terms.swapId, (x) => ({ ...x, own: { ...x.own, funding, fundingStartedAt: Date.now() } }))
    await commitBsvLock(prepared.txid, prepared.beef)
    beef = prepared.beef
  } else {
    const { coinWalletOf } = await import('../coinMethods')
    const wallet = await coinWalletOf(leg.chain)
    const already = Object.entries(wallet.store.read().payments).find(([, p]) => p.lock?.swapId === r.terms.swapId)
    let txid: string | undefined = already?.[0]
    if (!txid) {
      if (r.own.fundingStartedAt) {
        // The coin record holds a lock before it can be broadcast: an interrupted start left nothing out. Judge the swap again.
        updateSwap(r.terms.swapId, (x) => ({ ...x, own: { ...x.own, fundingStartedAt: undefined } }))
        throw new Error('an interrupted lock left nothing signed; judging the swap again')
      }
      updateSwap(r.terms.swapId, (x) => ({ ...x, own: { ...x.own, fundingStartedAt: Date.now() } }))
      const locks = [outs.main, ...(outs.fee ? [outs.fee] : [])]
      try {
        const sent = await wallet.fundLocks(
          locks.map((l) => ({ script: l.scriptPubKey, litoshi: l.amount, address: l.address! })),
          { swapId: r.terms.swapId, note: `Swap lock for ${SWAP_ASSET_INFO[swapLegs(agreed)[peerLegId(r)].chain].ticker}` },
        )
        txid = sent.ltcTxid
      } catch (err) {
        // The coin record holds a lock from the moment it is signed, before any broadcast: none there means none can be out.
        if (!Object.values(wallet.store.read().payments).some((p) => p.lock?.swapId === r.terms.swapId)) {
          updateSwap(r.terms.swapId, (x) => ({ ...x, own: { ...x.own, fundingStartedAt: undefined } }))
        }
        throw err
      }
    }
    funding = { txid, main: 0, ...(outs.fee ? { fee: 1 } : {}) }
    journalOwnLocks(active, r, funding, outs)
    updateSwap(r.terms.swapId, (x) => ({ ...x, own: { ...x.own, funding } }))
  }
  log(r.terms.swapId, `locked ${unitsToDecimal(leg.chain, leg.amount + leg.fee)} ${SWAP_ASSET_INFO[leg.chain].ticker} in ${funding.txid.slice(0, 12)}`)
  // The lock stands; the notice is retried while the swap waits on the peer.
  await announceFunded(active, { ...r, own: { ...r.own, funding } }, beef).catch((err: unknown) => {
    warn(r.terms.swapId, `funded notice deferred — ${err instanceof Error ? err.message : String(err)}`)
  })
}

const shortOfFunds = (err: unknown) => err instanceof Error && /insufficient funds/i.test(err.message)

/**
 * Fund, healing once when the wallet reports itself short: coins it holds
 * may be marked spent by a transaction it wrongly wrote off. Still short on
 * a fresh balance read, this wallet withdraws from the swap by name rather
 * than retrying until the window closes; the counterparty's lock (if any)
 * waits out its own lock time, as after any decline.
 */
async function fundOrWithdraw(active: ActiveWallet, r: SettleRecord): Promise<'locked' | 'withdrew'> {
  try {
    await fund(active, r)
    return 'locked'
  } catch (err) {
    if (!shortOfFunds(err) || readSettleState().swaps[r.terms.swapId]?.own.funding) throw err
  }
  if (!healedShort.has(r.terms.swapId)) {
    healedShort.add(r.terms.swapId)
    const { restoreFailedLocalTxsKnownOnChain } = await import('../staleOutputRelease')
    const startedAt = Date.now()
    const restored = await restoreFailedLocalTxsKnownOnChain().catch(() => 0)
    log(r.terms.swapId, `short to lock: restored ${restored} landed spend(s) done ${Date.now() - startedAt}ms`)
    try {
      await fund(active, r)
      return 'locked'
    } catch (err) {
      if (!shortOfFunds(err) || readSettleState().swaps[r.terms.swapId]?.own.funding) throw err
    }
  }
  const short = await canLock(r.role, r.terms)
  if (!short) throw new Error('Insufficient funds to lock right now; trying again')
  updateSwap(r.terms.swapId, (x) => ({ ...x, declined: short }))
  warn(r.terms.swapId, `withdrew: ${short} to lock`)
  await sendSettle(active, r.counterparty, { t: r.role === 'maker' ? 'decline' : 'abort', swapId: r.terms.swapId, reason: short }).catch(() => {})
  return 'withdrew'
}

const overBoxLimit = (err: unknown) => err instanceof Error && /exceeds the BRC-33 body limit/.test(err.message)

async function announceFunded(active: ActiveWallet, r: SettleRecord, beef?: string): Promise<void> {
  const funding = r.own.funding
  if (!funding) return
  const funded = (b?: string) =>
    sendSettle(active, r.counterparty, {
      t: 'funded',
      swapId: r.terms.swapId,
      leg: ownLegId(r),
      txid: funding.txid,
      main: funding.main,
      ...(funding.fee !== undefined ? { fee: funding.fee } : {}),
      ...(b ? { beef: b } : {}),
    })
  try {
    await funded(beef)
  } catch (err) {
    if (!beef || !overBoxLimit(err)) throw err
    log(r.terms.swapId, `lock ancestry over the message box limit; sending the lock alone`)
    await funded(leanBsvLockBeef(beef, funding.txid))
  }
  updateSwap(r.terms.swapId, (x) => ({ ...x, own: { ...x.own, fundedSentAt: Date.now() } }))
}

/** The counterparty's lock as the custody journal keeps it, with the presigned claim when there is one. */
function journalPeerLock(active: ActiveWallet, r: SettleRecord, template?: StoredClaimTemplate): void {
  const agreed = agreedOf(r)!
  const leg = swapLegs(agreed)[peerLegId(r)]
  const funding = r.peer.funding!
  const claim = template
    ? { hex: template.hex, at: template.secretAt, ...(template.remittance ? { prefix: template.remittance.derivationPrefix, suffix: template.remittance.derivationSuffix } : {}) }
    : undefined
  journalSwapLock(active, `${funding.txid}.${funding.main}`, legOutputs(agreed, peerLegId(r)).main.amount, {
    chain: leg.chain,
    swapId: r.terms.swapId,
    role: r.role,
    side: 'peer',
    terms: recipeTerms(r),
    ...(claim ? { claim } : {}),
  })
}

/**
 * Maker, waiting for the secret: sign the claim of the taker's lock now and
 * hand it to the claim watchtowers (this wallet's own box host, then
 * BRC-CLOUD), so a taker's claim seen while this wallet is away still gets
 * the maker's claim out before the taker may refund. The template is in the
 * custody journal before any tower sees it.
 */
async function armClaimTower(active: ActiveWallet, r: SettleRecord): Promise<void> {
  if (r.role !== 'maker' || r.secret || r.outcome || !r.own.funding || !r.peer.funding || !r.peer.buried || r.peer.refused || r.peer.claimed) return
  if (r.peer.tower?.done || (r.peer.tower && Date.now() - r.peer.tower.triedAt < TOWER_RETRY_MS)) return
  const agreed = agreedOf(r)!
  const legs = swapLegs(agreed)
  const peerOuts = legOutputs(agreed, peerLegId(r))
  const ownOuts = legOutputs(agreed, ownLegId(r))
  const held = r.peer.tower?.held ?? []
  updateSwap(r.terms.swapId, (x) => ({ ...x, peer: { ...x.peer, tower: { triedAt: Date.now(), held } } }))
  let template = r.peer.claimTemplate
  if (!template) {
    const funding = r.peer.funding
    const chain = await legChainOf(legs[peerLegId(r)].chain)
    try {
      template = await chain.presignClaim({ coin: { txid: funding.txid, vout: funding.main, amount: peerOuts.main.amount, script: peerOuts.main.script }, key: keyOf(active, r) })
    } catch (err) {
      const skipped = err instanceof Error ? err.message : String(err)
      updateSwap(r.terms.swapId, (x) => ({ ...x, peer: { ...x.peer, tower: { triedAt: Date.now(), held, done: true, skipped } } }))
      warn(r.terms.swapId, `no claim watchtower: ${skipped}`)
      return
    }
    journalPeerLock(active, r, template)
    const made = template
    updateSwap(r.terms.swapId, (x) => ({ ...x, peer: { ...x.peer, claimTemplate: made } }))
  }
  const ticket: ClaimTicket = {
    v: 1,
    watch: { chain: legs[ownLegId(r)].chain, txid: r.own.funding.txid, vout: r.own.funding.main, script: toHex(ownOuts.main.script) },
    hash: r.terms.hash,
    claim: { chain: template.chain, hex: template.hex, secretAt: template.secretAt, script: toHex(peerOuts.main.script) },
    until: legs[peerLegId(r)].locktime,
  }
  const origins = (await claimTowerOrigins()).filter((o) => !held.includes(o))
  const answers = await Promise.all(origins.map(async (o) => [o, await registerClaimTicket(o, ticket)] as const))
  const nowHeld = [...held, ...answers.filter(([, a]) => a === 'held').map(([o]) => o)]
  const done = answers.every(([, a]) => a !== 'retry')
  updateSwap(r.terms.swapId, (x) => ({ ...x, peer: { ...x.peer, tower: { triedAt: Date.now(), held: nowHeld, ...(done ? { done: true as const } : {}) } } }))
  if (nowHeld.length > held.length) log(r.terms.swapId, `claim watchtower armed at ${nowHeld.map((o) => new URL(o).host).join(', ')}`)
}

/** How the claim is built: the template a watchtower also holds (same transaction, whoever broadcasts first), or signed now. */
type ClaimBuild = { kind: 'presigned'; template: StoredClaimTemplate } | { kind: 'fresh' }

async function claim(active: ActiveWallet, r: SettleRecord): Promise<void> {
  const agreed = agreedOf(r)!
  const legId = peerLegId(r)
  const leg = swapLegs(agreed)[legId]
  const outs = legOutputs(agreed, legId)
  const funding = r.peer.funding!
  const secret = r.role === 'taker' ? swapSecret(rootOf(active), r.terms.swapId) : fromHex(r.secret!)
  if (secretHash(secret) !== r.terms.hash) throw new Error('the secret does not open this swap')
  const chain = await legChainOf(leg.chain)
  const outpoint = `${funding.txid}.${funding.main}`
  const build: ClaimBuild = r.role === 'maker' && r.peer.claimTemplate ? { kind: 'presigned', template: r.peer.claimTemplate } : { kind: 'fresh' }
  journalPeerLock(active, r, build.kind === 'presigned' ? build.template : undefined)
  const spend =
    build.kind === 'presigned'
      ? await chain.spendTemplate({ template: build.template, secret, hash: r.terms.hash, ...(funding.beef ? { sourceBeef: funding.beef } : {}), label: 'claim' })
      : await chain.spendLock({
          coins: [{ txid: funding.txid, vout: funding.main, amount: outs.main.amount, script: outs.main.script }],
          key: keyOf(active, r),
          path: { kind: 'claim', preimage: secret },
          ...(funding.beef ? { sourceBeef: funding.beef } : {}),
          label: 'claim',
        })
  updateSwap(r.terms.swapId, (x) => ({ ...x, peer: { ...x.peer, claim: { txid: spend.txid, hex: spend.hex } } }))
  await spend.commit()
  journalSwapLockSpent(active, outpoint)
  updateSwap(r.terms.swapId, (x) => ({ ...x, peer: { ...x.peer, claimed: true } }))
  log(r.terms.swapId, `claimed ${unitsToDecimal(leg.chain, spend.value)} ${SWAP_ASSET_INFO[leg.chain].ticker} in ${spend.txid.slice(0, 12)}`)
  if (r.role === 'taker') {
    await sendSettle(active, r.counterparty, { t: 'secret', swapId: r.terms.swapId, secret: toHex(secret) }).catch((err: unknown) => {
      warn(r.terms.swapId, `courtesy secret deferred — ${err instanceof Error ? err.message : String(err)}`)
    })
  }
}

/** Take this wallet's lock back: the swap output, the fee output, or both. */
async function refund(active: ActiveWallet, r: SettleRecord, which: 'all' | 'fee'): Promise<void> {
  const agreed = agreedOf(r)!
  const legId = ownLegId(r)
  const leg = swapLegs(agreed)[legId]
  const outs = legOutputs(agreed, legId)
  const funding = r.own.funding!
  const chain = await legChainOf(leg.chain)
  const key = keyOf(active, r)
  const parts: Array<{ lock: LegScript; vout: number; idx: number }> = []
  if (which === 'all' && !r.own.refunded) parts.push({ lock: outs.main, vout: funding.main, idx: 0 })
  if (outs.fee && funding.fee !== undefined && !r.own.feeSettled) parts.push({ lock: outs.fee, vout: funding.fee, idx: 1 })
  if (parts.length === 0) return
  const coinOf = (p: (typeof parts)[number]): HtlcCoin => ({ txid: funding.txid, vout: p.vout, amount: p.lock.amount, script: p.lock.script })
  // v1 BSV refunds are the pre-signed transactions, one per output; every other refund is built now, one for all.
  const spends =
    leg.chain === 'bsv' && agreed.v === 1
      ? await Promise.all(
          parts.map((p) => {
            const refund = r.own.refunds![p.idx]!
            return chain.spendLock({
              coins: [coinOf(p)],
              key,
              path: { kind: 'refund', locktime: leg.locktime, cosigs: [fromHex(refund.cosig!)] },
              fixed: { to: fromHex(refund.to), value: BigInt(refund.value), remittance: refund.remittance },
              sourceBeef: r.own.prepared!.beef,
              label: p.idx === 0 ? 'refund' : 'fee refund',
            })
          }),
        )
      : [
          await chain.spendLock({
            coins: parts.map(coinOf),
            key,
            path: { kind: 'refund', locktime: leg.locktime },
            ...(r.own.prepared ? { sourceBeef: r.own.prepared.beef } : {}),
            label: which === 'fee' ? 'fee refund' : 'refund',
          }),
        ]
  updateSwap(r.terms.swapId, (x) => {
    if (which === 'all') x.own.refund = { txid: spends[0]!.txid, hex: spends[0]!.hex }
    else x.own.feeRefund = { txid: spends[0]!.txid, hex: spends[0]!.hex }
    return x
  })
  for (const spend of spends) await spend.commit()
  for (const p of parts) journalSwapLockSpent(active, `${funding.txid}.${p.vout}`)
  updateSwap(r.terms.swapId, (x) => {
    if (parts.some((p) => p.idx === 0)) x.own.refunded = true
    if (parts.some((p) => p.idx === 1)) x.own.feeSettled = 'refunded'
    return x
  })
  log(r.terms.swapId, `${which === 'fee' ? 'fee lock' : 'lock'} taken back`)
}

async function finish(active: ActiveWallet, r: SettleRecord, step: Extract<SettleStep, { kind: 'done' }>): Promise<void> {
  if ((step.outcome === 'expired' || step.outcome === 'declined') && r.own.prepared && !r.own.funding) await abortBsvLock(r.own.prepared.txid)
  if (step.outcome === 'expired' && !r.own.funding && !r.declined) {
    await sendSettle(active, r.counterparty, { t: 'abort', swapId: r.terms.swapId, reason: 'expired' }).catch(() => {})
  }
  // The custody journal keeps the lock's recipe: should the verdict ever be wrong, a restore still finds it.
  if (step.outcome === 'unsent' && !r.declined) {
    await sendSettle(active, r.counterparty, { t: 'abort', swapId: r.terms.swapId, reason: 'lock never reached the chain' }).catch(() => {})
  }
  updateSwap(r.terms.swapId, (x) => ({ ...x, outcome: step.outcome, waiting: undefined }))
  log(r.terms.swapId, `done: ${step.outcome}`)
}

/** One swap, one step. */
async function advance(active: ActiveWallet, record: SettleRecord): Promise<SettleStep> {
  const c = chart(record)
  const savePhase = () => updateSwap(record.terms.swapId, (x) => (x.phase === c.phase() ? null : { ...x, phase: c.phase() }))
  try {
    const seen = await findPeerLock(record)
    const g = await gather(active, seen)
    const r = recordFacts(seen, g)
    await reportFee(r)
    const step = nextSettleStep(r.terms, g.facts)
    if (step.kind === 'wait') {
      savePhase()
      if (waitLogged.get(r.terms.swapId) !== step.for) {
        waitLogged.set(r.terms.swapId, step.for)
        log(r.terms.swapId, `waiting for ${step.for}${step.until ? ` until ${new Date(step.until).toISOString()}` : ''}`)
      }
      updateSwap(r.terms.swapId, (x) => ({ ...x, waiting: { for: step.for, ...(step.until ? { until: step.until } : {}) }, lastError: undefined }))
      if (step.for === 'peer-funding' && r.own.funding && (!r.own.fundedSentAt || Date.now() - r.own.fundedSentAt > FUNDED_RETRY_MS)) {
        await announceFunded(active, r, r.own.prepared?.beef)
      }
      if (step.for === 'secret') {
        await armClaimTower(active, r).catch((err: unknown) => {
          warn(r.terms.swapId, `claim watchtower deferred — ${err instanceof Error ? err.message : String(err)}`)
        })
      }
      return step
    }
    if (!c.take(eventOf(step))) {
      warn(r.terms.swapId, `refused ${step.kind} from ${c.phase()}`)
      savePhase()
      return { kind: 'wait', for: 'locktime' }
    }
    savePhase()
    try {
      switch (step.kind) {
        case 'request-presign':
          await requestPresign(active, r)
          break
        case 'fund':
          if ((await fundOrWithdraw(active, r)) === 'withdrew') {
            c.take({ type: 'FAIL', error: 'withdrew before locking' })
            return step
          }
          break
        case 'claim':
          await claim(active, r)
          break
        case 'refund':
          await refund(active, r, 'all')
          break
        case 'refund-fee':
          await refund(active, r, 'fee')
          break
        case 'done':
          await finish(active, r, step)
          break
      }
      c.take({ type: 'OK' })
    } catch (err) {
      c.take({ type: 'FAIL', error: err instanceof Error ? err.message : String(err) })
      throw err
    } finally {
      savePhase()
    }
    return step
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    updateSwap(record.terms.swapId, (x) => ({ ...x, lastError: message.slice(0, 300) }))
    warn(record.terms.swapId, `step deferred — ${message}`)
    return { kind: 'wait', for: 'locktime' }
  } finally {
    c.stop()
  }
}

// ── Service ───────────────────────────────────────────────────────────────

/**
 * One pass: the box at most every 20 s, each moving swap at most every 30 s,
 * and every Exolix exchange still moving at the same pace, Swap panel open or not.
 * Never on an account held by another device; every lock and claim is
 * guarded again where it spends.
 */
export async function serveSwapSettle(opts?: { force?: boolean }): Promise<void> {
  let active: ActiveWallet
  try {
    active = requireActiveWallet()
  } catch {
    return
  }
  if (serving) return
  const { activeAccountSpendRefusal } = await import('../vaultAccountHolding')
  if (activeAccountSpendRefusal(active)) return
  const account = `${active.identityKey}:${active.accountIndex ?? 0}`
  if (replayedFor !== account) {
    replayedFor = account
    const rebuilt = await replaySwapCustody(active).catch((err: unknown) => {
      console.warn(`[swap-settle] custody replay deferred — ${err instanceof Error ? err.message : String(err)}`)
      replayedFor = null
      return 0
    })
    if (rebuilt) console.info(`[swap-settle] rebuilt ${rebuilt} swap(s) from the custody journal`)
  }
  const now = Date.now()
  const box = opts?.force || now - boxPolledAt >= BOX_POLL_MS
  const tick = opts?.force || now - tickedAt >= TICK_MS
  if (!box && !tick) return
  serving = true
  const startedAt = now
  try {
    if (box) {
      boxPolledAt = now
      await serveBox(active)
    }
    if (tick) {
      tickedAt = now
      for (const record of activeSwaps()) {
        if (!opts?.force && (checkAt.get(record.terms.swapId) ?? 0) > Date.now()) continue
        const step = await advance(active, record)
        checkAt.set(record.terms.swapId, Date.now() + recheckAfter(step))
      }
      if (followedSwapRecords().length > 0) await refreshSwapRecords()
    }
  } finally {
    serving = false
    const ms = Date.now() - startedAt
    if (ms > 250) console.info(`[swap-settle] pass done ${ms}ms`)
  }
}

export function resetSwapSettleForTest(): void {
  boxPolledAt = 0
  tickedAt = 0
  serving = false
  replayedFor = null
  checkAt.clear()
  waitLogged.clear()
  lockSearchedAt.clear()
  healedShort.clear()
}

/** Rebuild swaps whose record this install lost (a restore) from the custody journal, so their locks still settle. */
export async function replaySwapCustody(active: ActiveWallet): Promise<number> {
  const { unspentSwapCustody } = await import('../custodyJournal')
  const owner = { identityKey: active.identityKey, accountIndex: active.accountIndex ?? 0, chain: active.chain }
  const state = readSettleState()
  const kept = new Set(Object.keys(state.swaps))
  let rebuilt = 0
  for (const { op, r } of unspentSwapCustody(owner)) {
    if (kept.has(r.swapId)) continue
    let terms: AgreedTerms
    try {
      terms = JSON.parse(r.terms) as AgreedTerms
    } catch {
      continue
    }
    if (terms.swapId !== r.swapId) continue
    const [txid, vout] = op.split('.') as [string, string]
    const counterparty = r.role === 'taker' ? terms.offer.maker : terms.taker
    // v1 kept the maker's key beside the terms; v2 terms carry it.
    const { makerPub, ...v1Base } = terms
    const base: SwapTerms = terms.v === 2 ? terms : v1Base
    const record: SettleRecord = state.swaps[r.swapId] ?? {
      v: 1,
      role: r.role,
      counterparty,
      terms: base,
      makerPub,
      accepted: true,
      own: {},
      peer: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    if (r.side === 'own') record.own.funding = { ...(record.own.funding ?? { txid, main: Number(vout) }), txid, main: Number(vout) }
    if (r.side === 'fee' && record.own.funding) record.own.funding.fee = Number(vout)
    if (r.side === 'peer') record.peer.funding = { txid, main: Number(vout) }
    if (r.side === 'peer' && r.claim) {
      const peerChain = swapLegs(terms)[r.role === 'taker' ? 'maker' : 'taker'].chain
      record.peer.claimTemplate = {
        chain: peerChain,
        hex: r.claim.hex,
        secretAt: r.claim.at,
        ...(r.claim.prefix && r.claim.suffix ? { remittance: { derivationPrefix: r.claim.prefix, derivationSuffix: r.claim.suffix, senderIdentityKey: active.identityKey.toLowerCase() } } : {}),
      }
    }
    if (r.refund && (r.side === 'own' || r.side === 'fee')) {
      const refunds = record.own.refunds ?? []
      refunds[r.side === 'own' ? 0 : 1] = {
        vout: Number(vout),
        to: r.refund.to,
        value: r.refund.value,
        cosig: r.refund.cosig,
        remittance: { derivationPrefix: r.refund.prefix, derivationSuffix: r.refund.suffix, senderIdentityKey: active.identityKey.toLowerCase() },
      }
      record.own.refunds = refunds
    }
    record.phase = record.own.funding ? 'locked' : (record.phase ?? 'negotiating')
    state.swaps[r.swapId] = record
    rebuilt += 1
  }
  if (rebuilt) writeSettleState(state)
  return rebuilt
}
