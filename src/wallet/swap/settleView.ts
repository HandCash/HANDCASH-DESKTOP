import { SWAP_ASSET_INFO, type SwapAsset } from './assets'
import { swapLegs } from './settle'
import type { SettleRecord } from './settleStore'

/** Where a wallet-to-wallet swap stands. */
export type SwapStanding = {
  /** `data-aeon-state`: the outcome once there is one, else what the swap waits on, else its phase. */
  state: string
  status: string
}

const clock = (ms: number | undefined) => (ms ? new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'its deadline')
const until = (ms: number | undefined) => (ms ? `, ${clock(ms)}` : '')

/** How often each chain makes a block, for telling someone how long a confirmation usually takes. */
const BLOCK_EVERY: Record<SwapAsset, string> = {
  bsv: 'about every 10 minutes',
  btc: 'about every 10 minutes',
  bch: 'about every 10 minutes',
  ltc: 'about every 2½ minutes',
  doge: 'about every minute',
}

/** A lock on `chain` waiting for its block, with the count toward the depth the other side needs once it is in one. */
function confirming(chain: SwapAsset, c: { have: number; need: number } | undefined): string {
  const { ticker } = SWAP_ASSET_INFO[chain]
  return c && c.have > 0 ? `has ${c.have} of ${c.need} ${ticker} confirmations` : `is waiting for a ${ticker} block (${BLOCK_EVERY[chain]})`
}

/** Where one swap stands as this wallet sees it, in words. */
export function describeSwap(r: SettleRecord): SwapStanding {
  const peer = r.role === 'taker' ? 'the maker' : 'the taker'
  const row = (state: string, status: string): SwapStanding => ({
    state,
    status: r.lastError && !r.outcome ? `${status} · last try: ${r.lastError}` : status,
  })

  switch (r.outcome) {
    case 'swapped':
      return row('swapped', 'Swapped')
    case 'refunded':
      return row('refunded', 'Refunded: your coins came back')
    case 'declined':
      return row('declined', `Declined by ${peer}${r.declined ? ` (${r.declined})` : ''}; nothing was locked`)
    case 'expired':
      return row('expired', 'Expired before anything was locked')
    case 'missed':
      return row('missed', 'The taker refunded before this wallet claimed')
    case 'unsent':
      return row('unsent', 'Your lock never reached the chain; nothing was locked')
  }
  if (r.declined && r.own.funding) return row('declined', `Declined by ${peer} (${r.declined}); your lock comes back at its lock time${until(r.waiting?.until)}`)
  if (r.peer.refused) return row('refused', `${peer[0]!.toUpperCase()}${peer.slice(1)}'s lock does not match the terms; yours refunds at its lock time`)
  switch (r.phase) {
    case 'locking':
      return row('locking', 'Locking your side')
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
      if (ownUnburied) return row('peer-funding', `Your lock ${confirming(ownChain, r.own.confirmations)}; ${peer} locks once it confirms`)
      return row('peer-funding', `Waiting for ${peer} to lock${r.terms.v === 2 && r.role === 'taker' ? `; it may be offline, and has until ${clock(r.waiting.until)}` : ''}`)
    case 'peer-burial':
      return row('peer-burial', `${peer[0]!.toUpperCase()}${peer.slice(1)}'s lock ${confirming(peerChain, r.peer.confirmations)}; you ${r.role === 'maker' ? 'lock' : 'claim'} once it confirms`)
    case 'secret':
      if (ownUnburied) return row('secret', `Your lock ${confirming(ownChain, r.own.confirmations)}; ${peer} claims once it confirms`)
      return row('secret', `Waiting for ${peer} to claim`)
    case 'locktime':
      return row('locktime', 'Waiting for the lock time to take your coins back')
  }
  return row(r.phase ?? 'negotiating', 'Starting')
}
