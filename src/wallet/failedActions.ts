/**
 * Failed-action triage and repair.
 *
 * A "failed" action is one the toolbox gave up on, and its `provenTxReq` says
 * why: `invalid` means no miner ever accepted it, `doubleSpend` means something
 * else spent its inputs first. Until the wallet repairs its own bookkeeping the
 * coins those actions moved stay unspendable, which reads to the user as money
 * vanishing — so name the cause, then run the toolbox's own recovery.
 *
 * Recovery order matters. `UnFail` first, because a transaction that really did
 * land must be promoted rather than have its inputs handed back; only then does
 * `reviewStatus` release what is genuinely dead.
 */
import type { ActiveWallet } from './session'

/** One page is plenty — this is a diagnosis, not an audit. */
const SCAN_LIMIT = 100

/**
 * A req that stays `invalid` is re-queued by every repair, and each one costs a
 * merkle-path lookup. Rejected transactions do not become mineable on their own,
 * so pace the retry rather than making Refresh wait on the whole set again.
 */
export const REPAIR_THROTTLE_MS = 10 * 60_000

let lastRepairAt = 0

/** Notes carry the payload inline; these keys are noise or unbounded hex. */
const CAUSE_SKIP_KEYS = new Set(['when', 'what', 'txid', 'rawTx', 'inputBEEF', 'beef'])

/** Distinct causes worth naming in one log line. */
const MAX_CAUSES = 6

type FailedAction = {
  txid?: string
  status?: string
  satoshis?: number
}

type ReqRow = {
  txid: string
  status?: string
  attempts?: number
  wasBroadcast?: boolean
  history?: string
}

export type FailedActionReport = {
  /** Failed actions the wallet holds. */
  count: number
  /** Satoshis those actions accounted for, by the wallet's own reckoning. */
  satoshis: number
  /** Reqs no miner ever accepted — nothing of theirs reached the chain. */
  neverBroadcast: number
  /** Reqs whose inputs another transaction spent first. */
  doubleSpend: number
  /** Distinct rejection causes, newest note per req. */
  causes: string[]
}

type StorageLike = {
  findProvenTxReqs?: (args: {
    partial: Record<string, unknown>
    txids?: string[]
    paged?: { limit: number; offset?: number }
  }) => Promise<ReqRow[]>
  runAsStorageProvider?: <R>(
    run: (active: { reviewStatus: (args: { agedLimit: Date }) => Promise<{ log: string }> }) => Promise<R>,
  ) => Promise<R>
}

type WalletLike = {
  listFailedActions?: (
    args: { labels: string[]; limit: number; seekPermission?: boolean },
    unfail?: boolean,
  ) => Promise<{ totalActions?: number; actions?: FailedAction[] }>
  storage?: StorageLike
}

type MonitorLike = { runTask?: (name: string) => Promise<string> }

function walletOf(active: ActiveWallet): WalletLike {
  return active.wallet as unknown as WalletLike
}

function monitorOf(active: ActiveWallet): MonitorLike | undefined {
  return (active as { monitor?: MonitorLike }).monitor
}

/** Readable one-liner for a history note, keeping only the fields that carry signal. */
export function describeReqNote(note: Record<string, unknown>): string {
  const what = typeof note.what === 'string' && note.what.trim() ? note.what.trim() : 'unknown'
  const extras = Object.entries(note)
    .filter(([key, value]) => {
      if (CAUSE_SKIP_KEYS.has(key)) return false
      // `noRawTx: false` and friends are the healthy case — only flag what is set.
      return value !== undefined && value !== null && value !== false && value !== ''
    })
    .slice(0, 4)
    .map(([key, value]) => `${key}=${String(value).slice(0, 80)}`)
  return extras.length > 0 ? `${what} (${extras.join(' ')})` : what
}

function lastNote(history: string | undefined): string | undefined {
  if (!history) return undefined
  try {
    const parsed = JSON.parse(history) as { notes?: unknown }
    const notes = Array.isArray(parsed.notes) ? parsed.notes : []
    for (let i = notes.length - 1; i >= 0; i -= 1) {
      const note = notes[i]
      if (note && typeof note === 'object' && !Array.isArray(note)) {
        return describeReqNote(note as Record<string, unknown>)
      }
    }
  } catch {
    /* history is advisory; a bad blob must not hide the count */
  }
  return undefined
}

function txidsOf(actions: FailedAction[]): string[] {
  const seen = new Set<string>()
  for (const action of actions) {
    const txid = action.txid?.trim().toLowerCase()
    // An action with no txid never got far enough to have one.
    if (txid) seen.add(txid)
  }
  return [...seen]
}

async function findReqs(active: ActiveWallet, txids: string[]): Promise<ReqRow[]> {
  const storage = walletOf(active).storage
  if (!storage || typeof storage.findProvenTxReqs !== 'function' || txids.length === 0) return []
  try {
    return await storage.findProvenTxReqs({ partial: {}, txids })
  } catch (err) {
    console.warn('[failed-actions] req lookup skipped', err)
    return []
  }
}

/**
 * What the wallet is holding and why. Read-only — moves no coins.
 *
 * Returns null when there is nothing to say, so callers can stay quiet.
 */
export async function diagnoseFailedActions(
  active: ActiveWallet,
): Promise<FailedActionReport | null> {
  const wallet = walletOf(active)
  if (typeof wallet.listFailedActions !== 'function') return null

  const failed = await wallet.listFailedActions({
    labels: [],
    limit: SCAN_LIMIT,
    seekPermission: false,
  })
  const actions = failed.actions ?? []
  const count = failed.totalActions ?? actions.length
  if (count <= 0) return null

  const reqs = await findReqs(active, txidsOf(actions))
  const causes = new Set<string>()
  let neverBroadcast = 0
  let doubleSpend = 0
  for (const req of reqs) {
    if (req.status === 'doubleSpend') doubleSpend += 1
    if (req.wasBroadcast !== true) neverBroadcast += 1
    const cause = lastNote(req.history)
    if (cause && causes.size < MAX_CAUSES) causes.add(cause)
  }

  return {
    count,
    satoshis: actions.reduce((sum, a) => sum + Math.abs(a.satoshis ?? 0), 0),
    neverBroadcast,
    doubleSpend,
    causes: [...causes],
  }
}

/**
 * Hand stranded coins back.
 *
 * `UnFail` promotes any action that actually landed on chain (it only ever
 * repairs local state — it never re-posts a rejected transaction), then
 * `reviewStatus` restores spendability of inputs held by terminally failed
 * transactions. Safe to run repeatedly, and throttled so a large backlog of
 * rejected transactions cannot keep stalling Refresh.
 */
export async function repairFailedActions(
  active: ActiveWallet,
  opts?: { force?: boolean; now?: number },
): Promise<{ queued: number; rescued: number; repaired: boolean; throttled?: true }> {
  const wallet = walletOf(active)
  if (typeof wallet.listFailedActions !== 'function') {
    return { queued: 0, rescued: 0, repaired: false }
  }

  const now = opts?.now ?? Date.now()
  if (!opts?.force && lastRepairAt > 0 && now - lastRepairAt < REPAIR_THROTTLE_MS) {
    return { queued: 0, rescued: 0, repaired: false, throttled: true }
  }
  lastRepairAt = now

  const queuedResult = await wallet.listFailedActions(
    { labels: [], limit: SCAN_LIMIT, seekPermission: false },
    true,
  )
  const actions = queuedResult.actions ?? []
  const txids = txidsOf(actions)
  const queued = queuedResult.totalActions ?? actions.length
  if (queued <= 0) return { queued: 0, rescued: 0, repaired: false }

  try {
    await monitorOf(active)?.runTask?.('UnFail')
  } catch (err) {
    console.warn('[failed-actions] UnFail task skipped', err)
  }

  // Anything that left a terminal status was really on chain all along.
  const after = await findReqs(active, txids)
  const rescued = after.filter(
    (req) => req.status !== 'invalid' && req.status !== 'doubleSpend' && req.status !== 'unfail',
  ).length

  let repaired = false
  const storage = wallet.storage
  if (storage && typeof storage.runAsStorageProvider === 'function') {
    try {
      await storage.runAsStorageProvider((sp) => sp.reviewStatus({ agedLimit: new Date() }))
      repaired = true
    } catch (err) {
      console.warn('[failed-actions] status repair skipped', err)
    }
  }

  return { queued, rescued, repaired }
}

/** Test-only */
export function resetFailedActionRepairForTests(): void {
  lastRepairAt = 0
}
