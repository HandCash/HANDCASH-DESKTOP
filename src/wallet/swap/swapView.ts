import { SWAP_ASSET_INFO, unitsToDecimal, type SwapAsset } from './assets'
import type { SwapRecord } from './exolixSwap'
import { takerTotals } from './settle'
import type { SettleRecord, SettleState } from './settleStore'
import { describeSwap } from './settleView'

/**
 * One swap as every surface shows it, whichever way it runs: wallet to wallet
 * (`settleStore`) or through Exolix (`exolixSwap`). Activity, the Swap panel
 * and the offer book read this, so a swap never reads one way in one place
 * and another way in the next.
 */

export type SwapRoute = 'direct' | 'exolix'

/** `done`: received. `moving`: not finished. `returned`: the paid coins came back. `stopped`: ended without a swap. */
export type SwapTone = 'done' | 'moving' | 'returned' | 'stopped'

/** What a transaction is to the swap. `peer-lock` is the counterparty's; every other leg is this wallet's. */
export type SwapLegRole = 'deposit' | 'payout' | 'lock' | 'peer-lock' | 'claim' | 'refund' | 'fee-refund'

export type SwapLeg = { role: SwapLegRole; asset: SwapAsset; txid: string }

export type SwapView = {
  /** `direct:<swapId>` or `exolix:<exchange id>`. */
  id: string
  route: SwapRoute
  /** The coin this wallet pays, and the one it receives. */
  from: SwapAsset
  to: SwapAsset
  pay: bigint
  receive: bigint
  /** The raw state token: a direct outcome, wait or phase; an Exolix status or stage. */
  state: string
  tone: SwapTone
  /** "0.1 BSV → 0.003 LTC" */
  title: string
  /** Where it stands, in words. */
  status: string
  legs: SwapLeg[]
  createdAt: number
  updatedAt: number
}

const TONES: Record<string, SwapTone> = {
  success: 'done',
  swapped: 'done',
  refunded: 'returned',
  created: 'stopped',
  'pay-failed': 'stopped',
  overdue: 'stopped',
  declined: 'stopped',
  expired: 'stopped',
  missed: 'stopped',
  unsent: 'stopped',
  refused: 'stopped',
}

export function swapTone(state: string): SwapTone {
  return TONES[state] ?? 'moving'
}

export const SWAP_TONE_LABEL: Record<SwapTone, string> = { done: 'Done', moving: 'In progress', returned: 'Refunded', stopped: 'Stopped' }

export const SWAP_ROUTE_LABEL: Record<SwapRoute, string> = { direct: 'Wallet to wallet', exolix: 'Exolix' }

export const SWAP_LEG_LABEL: Record<SwapLegRole, string> = {
  deposit: 'Deposit to Exolix',
  payout: 'Payout from Exolix',
  lock: 'Your lock',
  'peer-lock': 'Their lock',
  claim: 'Your claim',
  refund: 'Your refund',
  'fee-refund': 'Fee refund',
}

export const swapAmount = (asset: SwapAsset, units: bigint): string => `${unitsToDecimal(asset, units)} ${SWAP_ASSET_INFO[asset].ticker}`

const title = (from: SwapAsset, pay: bigint, to: SwapAsset, receive: bigint) => `${swapAmount(from, pay)} → ${swapAmount(to, receive)}`

/** Where an Exolix exchange stands, in words. */
export function exolixStatusText(record: SwapRecord): string {
  if (record.stage === 'created') return 'Opened, deposit not paid'
  if (record.stage === 'pay-failed') return `Deposit not paid${record.error ? ` — ${record.error}` : ''}`
  switch (record.status) {
    case 'wait':
      return 'Deposit sent, Exolix waiting for it'
    case 'confirmation':
    case 'confirmed':
      return 'Exolix confirming your deposit'
    case 'exchanging':
      return 'Exolix swapping'
    case 'sending':
      return 'Exolix paying out to this wallet'
    case 'success':
      return 'Paid out to this wallet'
    case 'overdue':
      return 'Expired at Exolix'
    case 'refunded':
      return 'Refunded to this wallet'
  }
}

const isTxid = (value: string | undefined): value is string => !!value && /^[0-9a-f]{64}$/i.test(value)

function legsOf(entries: ReadonlyArray<[SwapLegRole, SwapAsset, string | undefined]>): SwapLeg[] {
  const seen = new Set<string>()
  const legs: SwapLeg[] = []
  for (const [role, asset, txid] of entries) {
    if (!isTxid(txid)) continue
    const id = txid.toLowerCase()
    if (seen.has(id)) continue
    seen.add(id)
    legs.push({ role, asset, txid: id })
  }
  return legs
}

export function exolixSwapView(record: SwapRecord): SwapView {
  const state = record.stage === 'paid' ? record.status : record.stage
  return {
    id: `exolix:${record.id}`,
    route: 'exolix',
    from: record.from,
    to: record.to,
    pay: BigInt(record.pay),
    receive: BigInt(record.receive),
    state,
    tone: swapTone(state),
    title: title(record.from, BigInt(record.pay), record.to, BigInt(record.receive)),
    status: exolixStatusText(record),
    legs: legsOf([
      ['deposit', record.from, record.txid],
      ['payout', record.to, record.payoutTxid],
    ]),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export function directSwapView(record: SettleRecord): SwapView {
  const row = describeSwap(record)
  const { offer } = record.terms
  const taker = record.role === 'taker'
  const pay = taker ? takerTotals(record.terms).pays : BigInt(record.terms.receive)
  const receive = taker ? takerTotals(record.terms).receives : BigInt(record.terms.pay)
  const from = taker ? offer.get : offer.give
  const to = taker ? offer.give : offer.get
  return {
    id: `direct:${record.terms.swapId}`,
    route: 'direct',
    from,
    to,
    pay,
    receive,
    state: row.state,
    tone: swapTone(row.state),
    title: title(from, pay, to, receive),
    status: row.status,
    legs: legsOf([
      ['lock', from, record.outcome === 'unsent' ? undefined : (record.own.funding?.txid ?? record.own.prepared?.txid)],
      ['peer-lock', to, record.peer.funding?.txid],
      ['claim', to, record.peer.claim?.txid],
      ['refund', from, record.own.refund?.txid],
      ['fee-refund', from, record.own.feeRefund?.txid],
    ]),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/** How long a finished swap stays among the recent ones on the swap screens; Activity keeps it for good. */
const FINISHED_RECENT_MS = 24 * 3600_000

/** Swaps still moving, then those finished in the last day. */
export function recentSwapViews(views: readonly SwapView[], now: number): SwapView[] {
  return views.filter((view) => view.tone === 'moving' || now - view.updatedAt < FINISHED_RECENT_MS)
}

/** Every swap of the account, moving ones first, then newest. */
export function swapViews(settle: SettleState, exolix: readonly SwapRecord[]): SwapView[] {
  const views = [...Object.values(settle.swaps).map(directSwapView), ...exolix.map(exolixSwapView)]
  return views.sort((a, b) => Number(a.tone !== 'moving') - Number(b.tone !== 'moving') || b.createdAt - a.createdAt)
}
