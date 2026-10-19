import type { LockSighting } from '../coins/coinWallet'
import { fromHex, toHex } from '../ltc/litecoin'
import { legChainOf, type LegSpend } from './legChains'
import { legOutputs, swapLegs, takerLockTooLate, type SettleFacts } from './settle'
import type { FeeLockReport } from './feeClaim'
import { bsvLockProvenUnsent, reportFeeLock } from './settlePorts'
import { agreedOf, log, ownLegId, peerLegId, warn } from './settleShared'
import { updateSwap, type SettleRecord } from './settleStore'
import type { ActiveWallet } from '../session'

/** What this wallet knows of a swap: its record and both chains, read before any step acts. */

/** When each swap's counterparty lock was last searched for on chain. */
const lockSearchedAt = new Map<string, number>()
const LOCK_SEARCH_MS = 60_000

export function forgetLockSearches(): void {
  lockSearchedAt.clear()
}

type Gathered = { facts: SettleFacts; ownSpend: LegSpend | null; feeSpend: LegSpend | null; peerSpend: LegSpend | null; peerSighting: LockSighting | null }

export async function gather(active: ActiveWallet, r: SettleRecord): Promise<Gathered> {
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
export async function findPeerLock(r: SettleRecord): Promise<SettleRecord> {
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
export function recordFacts(r: SettleRecord, g: Gathered): SettleRecord {
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

export async function reportFee(r: SettleRecord): Promise<void> {
  if (r.feeReportedAt || r.outcome) return
  const report = feeLockReportOf(r)
  if (!report) return
  const taken = await reportFeeLock(report).catch(() => false)
  if (taken) updateSwap(r.terms.swapId, (x) => ({ ...x, feeReportedAt: Date.now() }))
}
