import type { AgreedTerms, SwapTerms } from './settle'
import { swapLegs } from './settle'
import { readSettleState, writeSettleState, type SettleRecord } from './settleStore'
import type { ActiveWallet } from '../session'

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
