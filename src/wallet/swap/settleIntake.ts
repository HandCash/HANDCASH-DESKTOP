import { fromHex } from '../ltc/litecoin'
import type { HtlcCoin } from './htlc'
import { bsvCosignValid, cosignBsvRefund } from './legChains'
import { checkTake, judgeTakeRoom, legOutputs, secretHash, swapLegs, swapSettleKey, swapSettlePub, type SettleMessage, type SwapTerms } from './settle'
import { ackSettleBox, readSettleBox, sendSettle } from './settlePorts'
import { agreedOf, canLock, log, ownLegId, peerLegId, rootOf, warn } from './settleShared'
import { readSettleState, updateSwap, writeSettleState, type SettleRecord } from './settleStore'
import type { SignedSwapOffer } from './offer'
import type { ActiveWallet } from '../session'

/** Box `swap-settle`: takes of this account's offers, and every message about a swap in progress. */

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

/** Read box `swap-settle` and take in every message; `onMessage` hears each swap a message moved. */
export async function serveBox(active: ActiveWallet, onMessage: (swapId: string | undefined) => void): Promise<void> {
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
        onMessage(message.t === 'take' ? message.terms?.swapId : message.swapId)
      }
      acks.push(messageId)
    } catch (err) {
      console.warn(`[swap-settle] message from ${sender.slice(0, 12)}… deferred — ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  await ackSettleBox(active, acks).catch(() => {})
}
