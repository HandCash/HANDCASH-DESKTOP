/**
 * Vocabulary of an item-migrate run: why one stops, and what each failure of a
 * bundle means. `itemMigrateRunMachine` owns what happens next; this module
 * only names things. Every caller — the run, the import queue, the sweep —
 * reads the same reasons and the same words.
 */
import { isInsufficientFundsError } from './insufficientFunds'

/**
 * Why a run stopped before every tip was tried. Untried tips are never
 * blamed: they answer `funds` or `deferred` with the message below.
 */
export type ItemMigrateStop =
  | 'funds'
  /** The wallet's fee coin was spent elsewhere and is being retired. */
  | 'stale-funding'
  /** The wallet stayed busy with another job past every wait. */
  | 'busy'
  /** A bundle the spend region gave up on never reported its outcome; it may still broadcast. */
  | 'abandoned'
  /** The last bundle is signed but Arcade has not taken it, so its change cannot fund the next. */
  | 'propagating'
  | 'network'
  /** The wallet locked or switched accounts mid-run. */
  | 'locked'

export const ITEM_MIGRATE_STOP_MESSAGES: Record<ItemMigrateStop, string> = {
  funds: 'Not enough spendable BSV in this wallet for the item fee. Add funds and import again — it resumes.',
  'stale-funding':
    'The wallet’s fee coin was spent elsewhere and is being cleared. Nothing was sent — it resumes in a moment.',
  busy: 'The wallet stayed busy with another job, so nothing was sent. Import again to move the rest.',
  abandoned:
    'A send stopped responding and its result is not known yet, so nothing else was built over those items. Import again to move the rest.',
  propagating:
    'The last transaction is still reaching the network, so its change cannot pay for the next one yet. It resumes in a moment.',
  network: 'The network stopped answering, so nothing else was sent. Import again to move the rest.',
  locked: 'The wallet locked or switched accounts, so nothing else was sent. Unlock it and import again to move the rest.',
}

/** Stops a short pause usually clears: the queue waits and tries the untried tips again. */
export function itemMigrateStopPauses(stop: ItemMigrateStop | null): boolean {
  return stop === 'stale-funding' || stop === 'propagating'
}

/**
 * One bundle's failure, classified once at the boundary.
 *
 * - `dead-tips` names the bundle's tips the chain already shows spent; they
 *   leave the run and the rest of the bundle goes again whole.
 * - `rejected` is about the bundle's tips; it is worth halving.
 * - Every other kind is about the wallet or the network, and a smaller bundle
 *   would fail the same way.
 */
export type ItemMigrateFault =
  | { kind: 'dead-tips'; message: string; dead: string[] }
  | { kind: 'busy'; message: string; held: string }
  | { kind: 'abandoned'; message: string; late: Promise<unknown> }
  | { kind: 'funds'; message: string }
  | { kind: 'stale-funding'; message: string }
  | { kind: 'locked'; message: string }
  | { kind: 'network'; message: string }
  | { kind: 'rejected'; message: string }

export type ItemMigrateFaultKind = ItemMigrateFault['kind']

const LOCKED_FAILURES = ['wallet_locked', 'wallet locked', 'wallet is locked', 'wallet account changed', 'unlock this wallet']

const NETWORK_FAILURES = [
  'offline',
  'failed to fetch',
  'fetch failed',
  'networkerror',
  'network request failed',
  'status 429',
  'status 502',
  'status 503',
  'status 504',
]

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The certainty gate refused over a coin this bundle did not name — the
 * wallet's own fee funding. Duck-typed: `inputCertainty` sits above this module.
 */
export function refusedOverFunding(err: unknown, group: ReadonlyArray<{ outpoint: string }>): boolean {
  const refusal = err as { code?: unknown; reason?: unknown; dead?: unknown } | null
  if (!refusal || refusal.code !== 'INPUTS_UNVERIFIED') return false
  if (refusal.reason === 'still-dead') return true
  if (refusal.reason !== 'input-spent' || !Array.isArray(refusal.dead) || refusal.dead.length === 0) return false
  return deadTipsOf(err, group).length === 0
}

const outpointKey = (outpoint: string) => outpoint.trim().toLowerCase().replace(/[_:]/, '.')

/**
 * The bundle's own tips the certainty gate found spent elsewhere, in the
 * bundle's spelling. Empty when the refusal was about something else.
 */
export function deadTipsOf(err: unknown, group: ReadonlyArray<{ outpoint: string }>): string[] {
  const refusal = err as { code?: unknown; reason?: unknown; dead?: unknown } | null
  if (!refusal || refusal.code !== 'INPUTS_UNVERIFIED' || refusal.reason !== 'input-spent') return []
  if (!Array.isArray(refusal.dead) || refusal.dead.length === 0) return []
  const dead = new Set(refusal.dead.map((outpoint) => outpointKey(String(outpoint))))
  return group.filter((item) => dead.has(outpointKey(item.outpoint))).map((item) => item.outpoint)
}

export function classifyItemMigrateFault(err: unknown, group: ReadonlyArray<{ outpoint: string }>): ItemMigrateFault {
  const message = messageOf(err)
  const coded = err as { code?: unknown; late?: unknown; name?: unknown; coordinatorSummary?: unknown } | null
  if (coded?.code === 'SPEND_REGION_ABANDONED') {
    return {
      kind: 'abandoned',
      message,
      late: coded.late instanceof Promise ? coded.late : Promise.resolve(undefined),
    }
  }
  if (coded?.name === 'WalletCoordinatorAcquireTimeoutError') {
    return { kind: 'busy', message, held: typeof coded.coordinatorSummary === 'string' ? coded.coordinatorSummary : 'unknown' }
  }
  if (isInsufficientFundsError(err)) return { kind: 'funds', message }
  const dead = deadTipsOf(err, group)
  if (dead.length > 0) return { kind: 'dead-tips', message, dead }
  if (refusedOverFunding(err, group)) return { kind: 'stale-funding', message }
  const lower = message.toLowerCase()
  if (LOCKED_FAILURES.some((needle) => lower.includes(needle))) return { kind: 'locked', message }
  if (NETWORK_FAILURES.some((needle) => lower.includes(needle))) return { kind: 'network', message }
  return { kind: 'rejected', message }
}
