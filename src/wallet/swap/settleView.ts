import type { SettleRecord } from './settleStore'

/** Where a wallet-to-wallet swap stands. */
export type SwapStanding = {
  /** `data-aeon-state`: the outcome once there is one, else what the swap waits on, else its phase. */
  state: string
  status: string
}

const clock = (ms: number | undefined) => (ms ? new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'its deadline')
const until = (ms: number | undefined) => (ms ? `, ${clock(ms)}` : '')

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
  switch (r.waiting?.for) {
    case 'accept':
      return row('accept', `Waiting for ${peer} to accept`)
    case 'presign':
      return row('presign', 'Exchanging refund signatures')
    case 'peer-funding':
      return row('peer-funding', `Waiting for ${peer} to lock${r.terms.v === 2 && r.role === 'taker' ? `; it may be offline, and has until ${clock(r.waiting.until)}` : ''}`)
    case 'peer-burial': {
      const c = r.peer.confirmations
      return row('peer-burial', `Waiting for ${peer}'s lock to confirm${c ? ` (${c.have}/${c.need})` : ''}`)
    }
    case 'secret':
      return row('secret', `Waiting for ${peer} to claim`)
    case 'locktime':
      return row('locktime', 'Waiting for the lock time to take your coins back')
  }
  return row(r.phase ?? 'negotiating', 'Starting')
}
