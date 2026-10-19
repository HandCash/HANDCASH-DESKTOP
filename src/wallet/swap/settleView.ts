import { COIN_INFO } from '../coins/coinChains'
import { SWAP_ASSET_INFO, type SwapAsset } from './assets'
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

const clock = (ms: number | undefined) => (ms ? new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'its deadline')
const until = (ms: number | undefined) => (ms ? `, ${clock(ms)}` : '')

/** How often `chain` makes a block, for telling someone how long a confirmation usually takes. */
function blockEvery(chain: SwapAsset): string {
  const minutes = chain === 'bsv' ? 10 : COIN_INFO[chain].blockMinutes
  return minutes === 1 ? 'about every minute' : `about every ${String(minutes).replace('.5', '½')} minutes`
}

/** A BSV lock is buried once a block holds it; a coin lock at its chain's depth. */
const depthOf = (chain: SwapAsset) => (chain === 'bsv' ? 1 : COIN_INFO[chain].confirmations)

function lockConfirming(chain: SwapAsset, c: { have: number; need: number } | undefined): LockConfirming {
  return c ? { chain, counted: Math.min(c.have, c.need), needed: c.need } : { chain, counted: 0, needed: depthOf(chain) }
}

/** A lock waiting for its block, or counting toward the depth the other side needs once it is in one. */
function confirmingText({ chain, counted, needed }: LockConfirming): string {
  const { ticker } = SWAP_ASSET_INFO[chain]
  return counted > 0 ? `has ${counted} of ${needed} ${ticker} confirmations` : `is waiting for a ${ticker} block (${blockEvery(chain)})`
}

/** Where one swap stands as this wallet sees it, in words. */
export function describeSwap(r: SettleRecord): SwapStanding {
  const peer = r.role === 'taker' ? 'the maker' : 'the taker'
  const row = (state: string, status: string, confirming?: LockConfirming): SwapStanding => ({
    state,
    status: r.lastError && !r.outcome ? `${status} · last try: ${r.lastError}` : status,
    ...(confirming ? { confirming } : {}),
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
      if (ownUnburied) {
        const c = lockConfirming(ownChain, r.own.confirmations)
        return row('peer-funding', `Your lock ${confirmingText(c)}; ${peer} locks once it confirms`, c)
      }
      return row('peer-funding', `Waiting for ${peer} to lock${r.terms.v === 2 && r.role === 'taker' ? `; it may be offline, and has until ${clock(r.waiting.until)}` : ''}`)
    case 'peer-burial': {
      const c = lockConfirming(peerChain, r.peer.confirmations)
      return row('peer-burial', `${peer[0]!.toUpperCase()}${peer.slice(1)}'s lock ${confirmingText(c)}; you ${r.role === 'maker' ? 'lock' : 'claim'} once it confirms`, c)
    }
    case 'secret':
      if (ownUnburied) {
        const c = lockConfirming(ownChain, r.own.confirmations)
        return row('secret', `Your lock ${confirmingText(c)}; ${peer} claims once it confirms`, c)
      }
      return row('secret', `Waiting for ${peer} to claim`)
    case 'locktime':
      return row('locktime', 'Waiting for the lock time to take your coins back')
  }
  return row(r.phase ?? 'negotiating', 'Starting')
}
