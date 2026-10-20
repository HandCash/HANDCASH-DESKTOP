import { COIN_INFO } from '../coins/coinChains'
import type { SwapAsset } from './assets'
import { swapLegs } from './settle'
import type { SettleRecord } from './settleStore'

/** Where a wallet-to-wallet swap stands. */
export type SwapStanding = {
  /** `data-aeon-state`: the outcome once there is one, else what the swap waits on, else its phase. */
  state: string
  status: string
  /** The lock the swap waits on to be buried, counted toward the depth its reader needs. */
  confirming?: LockConfirming
}

export type LockConfirming = { chain: SwapAsset; counted: number; needed: number }

const clock = (ms: number | undefined) => (ms ? new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'later')

/** A BSV lock is buried once a block holds it; a coin lock at its chain's depth. */
const depthOf = (chain: SwapAsset) => (chain === 'bsv' ? 1 : COIN_INFO[chain].confirmations)

function lockConfirming(chain: SwapAsset, c: { have: number; need: number } | undefined): LockConfirming {
  return c ? { chain, counted: Math.min(c.have, c.need), needed: c.need } : { chain, counted: 0, needed: depthOf(chain) }
}

/** Where one swap stands as this wallet sees it, in a few words; confirmation counts travel in `confirming`. */
export function describeSwap(r: SettleRecord): SwapStanding {
  const peer = r.role === 'taker' ? 'the maker' : 'the taker'
  const Peer = r.role === 'taker' ? 'The maker' : 'The taker'
  const row = (state: string, status: string, confirming?: LockConfirming): SwapStanding => ({
    state,
    status: r.lastError && !r.outcome ? `${status} · last try: ${r.lastError}` : status,
    ...(confirming ? { confirming } : {}),
  })

  switch (r.outcome) {
    case 'swapped':
      return row('swapped', 'Swapped')
    case 'refunded':
      return row('refunded', 'Refunded')
    case 'declined':
      return row('declined', `Declined by ${peer}${r.declined ? ` (${r.declined})` : ''} · nothing locked`)
    case 'expired':
      return row('expired', 'Expired · nothing locked')
    case 'missed':
      return row('missed', 'Missed: the taker refunded first')
    case 'unsent':
      return row('unsent', 'Your lock never went out · nothing locked')
  }
  // This wallet's claim is in, so the swap has happened; only the HandCash fee output on its own lock can still be open.
  if (r.peer.claimed) return row('swapped', r.waiting?.for === 'locktime' ? `Swapped · unclaimed fee returns to you ${clock(r.waiting.until)}` : 'Swapped')
  if (r.declined && r.own.funding) return row('declined', `Declined by ${peer} · refund opens ${clock(r.waiting?.until)}`)
  if (r.peer.refused) return row('refused', `${Peer}'s lock is wrong · refund opens ${clock(r.waiting?.until)}`)
  switch (r.phase) {
    case 'locking':
      return row('locking', 'Locking')
    case 'claiming':
      return row('claiming', 'Claiming')
    case 'refunding':
      return row('refunding', 'Refunding')
  }
  const legs = swapLegs(r.terms)
  const ownChain = legs[r.role].chain
  const peerChain = legs[r.role === 'taker' ? 'maker' : 'taker'].chain
  // The counterparty acts only on a buried lock: while this wallet's is not, it is what the swap waits on.
  const ownUnburied = !!r.own.funding && !r.own.buried
  switch (r.waiting?.for) {
    case 'accept':
      return row('accept', `Waiting for ${peer} to accept`)
    case 'presign':
      return row('presign', 'Exchanging refund signatures')
    case 'peer-funding':
      if (ownUnburied) return row('peer-funding', 'Confirming your lock', lockConfirming(ownChain, r.own.confirmations))
      return row('peer-funding', `Waiting for ${peer} to lock${r.terms.v === 2 && r.role === 'taker' ? ` · until ${clock(r.waiting.until)}` : ''}`)
    case 'peer-burial':
      return row('peer-burial', `Confirming ${peer}'s lock`, lockConfirming(peerChain, r.peer.confirmations))
    case 'chain-time':
      return row('chain-time', 'Preparing your claim')
    case 'secret':
      if (ownUnburied) return row('secret', 'Confirming your lock', lockConfirming(ownChain, r.own.confirmations))
      return row('secret', `Waiting for ${peer} to claim`)
    case 'locktime':
      return row('locktime', `Refund opens ${clock(r.waiting.until)}`)
  }
  return row(r.phase ?? 'negotiating', 'Starting')
}
