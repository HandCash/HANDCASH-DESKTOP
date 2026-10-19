import { fromHex, toHex } from '../ltc/litecoin'
import { SWAP_ASSET_INFO, unitsToDecimal } from './assets'
import type { HtlcCoin } from './htlc'
import type { ClaimTicket } from './claimTower'
import {
  abortBsvLock,
  bsvRefundValue,
  bsvSelfOutput,
  commitBsvLock,
  leanBsvLockBeef,
  legChainOf,
  prepareBsvLock,
  type StoredClaimTemplate,
} from './legChains'
import { legOutputs, secretHash, swapLegs, swapSecret, type LegScript, type SettleStep } from './settle'
import { claimTowerOrigins, journalSwapLock, journalSwapLockSpent, registerClaimTicket, sendSettle } from './settlePorts'
import { agreedOf, canLock, keyOf, log, ownLegId, peerLegId, recipeTerms, rootOf, warn } from './settleShared'
import { readSettleState, updateSwap, type SettleRecord } from './settleStore'
import type { ActiveWallet } from '../session'

/** The steps that move coins or messages. Each is written to the record before it runs and is safe to repeat. */

/** A presign request the counterparty has not answered is asked again after this. */
const PRESIGN_RETRY_MS = 2 * 60_000
/** A claim watchtower that did not answer is asked again after this. */
const TOWER_RETRY_MS = 10 * 60_000
/** Swaps whose lock already ran the once-a-session heal for being short. */
const healedShort = new Set<string>()

export function forgetShortHeals(): void {
  healedShort.clear()
}

export async function requestPresign(active: ActiveWallet, r: SettleRecord): Promise<void> {
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
export async function fundOrWithdraw(active: ActiveWallet, r: SettleRecord): Promise<'locked' | 'withdrew'> {
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

export async function announceFunded(active: ActiveWallet, r: SettleRecord, beef?: string): Promise<void> {
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
export async function armClaimTower(active: ActiveWallet, r: SettleRecord): Promise<void> {
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

export async function claim(active: ActiveWallet, r: SettleRecord): Promise<void> {
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
export async function refund(active: ActiveWallet, r: SettleRecord, which: 'all' | 'fee'): Promise<void> {
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

export async function finish(active: ActiveWallet, r: SettleRecord, step: Extract<SettleStep, { kind: 'done' }>): Promise<void> {
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
