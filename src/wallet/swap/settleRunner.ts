import { createActor } from 'xstate'
import { swapSettleMachine, type SwapSettleEvent, type SwapSettlePhase } from '../../machines/swapSettleMachine'
import { SWAP_ASSET_INFO, unitsToDecimal } from './assets'
import { followedSwapRecords, refreshSwapRecords } from './exolixSwap'
import { nextSettleStep, offerRemaining, proposeTerms, takeFits, takerTotals, type SettleStep } from './settle'
import { requireActiveWallet, sendSettle } from './settlePorts'
import { forgetLockSearches, findPeerLock, gather, recordFacts, reportFee } from './settleFacts'
import { serveBox } from './settleIntake'
import { replaySwapCustody } from './settleReplay'
import { canLock, log, rootOf, warn } from './settleShared'
import { announceFunded, armClaimTower, claim, finish, forgetShortHeals, fundOrWithdraw, refund, requestPresign } from './settleSteps'
import { markOfferCancelled, putSwap, readSettleState, rememberPublishedOffer, writeSettleState, activeSwaps, updateSwap, type SettleRecord } from './settleStore'
import type { SwapOfferDraft } from './offerBook'
import type { SignedSwapOffer } from './offer'
import type { ActiveWallet } from '../session'

export { replaySwapCustody }

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
/** A `funded` notice is sent again this often until the counterparty's lock appears (it may have missed one). */
const FUNDED_RETRY_MS = 10 * 60_000

let boxPolledAt = 0
let tickedAt = 0
let serving = false
/** The account whose swaps were last rebuilt from the custody journal. */
let replayedFor: string | null = null
/** When each swap is next worth a look; a message for it or a forced pass looks sooner. */
const checkAt = new Map<string, number>()
/** What each swap was last logged waiting on this session, so every upload names what a stuck swap waits for. */
const waitLogged = new Map<string, string>()

/** How long a swap waiting on `step` can go unexamined: chain reads are spent only when an answer could change the step. */
function recheckAfter(step: SettleStep): number {
  if (step.kind !== 'wait') return 0
  const until = step.until ? Math.max(0, step.until - Date.now()) : Infinity
  const every = { accept: 30_000, presign: 30_000, 'peer-funding': 60_000, 'peer-burial': 60_000, secret: 2 * 60_000, locktime: 10 * 60_000 }[step.for]
  return Math.min(every, until)
}

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

/**
 * Propose the terms of taking `offer` for `pay`, record them and send the
 * take, then lock at once: the maker need not be online, and judges the take
 * when it next is. If it declines (the offer was used up first), the lock
 * returns at T1.
 */
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
      await serveBox(active, (swapId) => {
        if (swapId) checkAt.delete(swapId)
      })
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
  forgetLockSearches()
  forgetShortHeals()
}
