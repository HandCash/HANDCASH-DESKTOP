/**
 * Runtime for `walletCoordinatorMachine` — per-region serial queues.
 * Overlaps that the machine forbids still wait on acquire; distinct regions no
 * longer share one FIFO (so a queued backup does not delay a waiting spend).
 */
import { createActor, type Actor } from 'xstate'
import { createSerialQueue } from './serialQueue'
import {
  canBeginChainIngest,
  canBeginHistoryReplica,
  canBeginRecompose,
  canBeginSpend,
  snapshotFromContext,
  walletCoordinatorMachine,
  type WalletCoordinatorContext,
  type WalletCoordinatorEvent,
  type WalletCoordinatorSnapshot,
} from './walletCoordinatorMachine'

/** One FIFO per region — serialize same-region work; machine owns cross-region exclusion. */
const chainIngestQueue = createSerialQueue()
const spendQueue = createSerialQueue()
const historyReplicaQueue = createSerialQueue()
const recomposeQueue = createSerialQueue()

let actor: Actor<typeof walletCoordinatorMachine> = createActor(walletCoordinatorMachine).start()

/**
 * Callers who want the FIFO freed for a spend. Chain ingest checks this to skip
 * ordinal work and finish early so a queued send can begin.
 *
 * Holds are named and expire. This is a scheduling *hint* — region exclusion is
 * owned by the machine, so a hold that outlives its work costs throughput, not
 * correctness. A leaked hold used to be permanent and invisible: chain ingest
 * stayed funding-only for the rest of the session, so items never got named or
 * verified, and history backup rescheduled itself forever. Expiring the hold and
 * naming the holder turns that into a bounded, diagnosable stall.
 */
type SpendPriorityHold = {
  id: number
  reason: string
  /** When the work started — what the stall report should quote. */
  since: number
  /** Last proof of life. Expiry is measured from here, not from `since`. */
  at: number
}

const SPEND_PRIORITY_MAX_MS = 90_000
/** Proof-of-life cadence for a hold whose work is still running. */
const SPEND_PRIORITY_TOUCH_MS = 30_000

let spendPriorityHolds: SpendPriorityHold[] = []
let nextSpendPriorityId = 1

/** Test-only — reset coordinator between cases. */
export function resetWalletCoordinatorForTests(): void {
  actor.stop()
  actor = createActor(walletCoordinatorMachine).start()
  spendPriorityHolds = []
}

function dropExpiredSpendPriority(now = Date.now()): void {
  if (spendPriorityHolds.length === 0) return
  const live: SpendPriorityHold[] = []
  for (const hold of spendPriorityHolds) {
    const heldMs = now - hold.at
    if (heldMs < SPEND_PRIORITY_MAX_MS) {
      live.push(hold)
      continue
    }
    console.warn(
      `[coordinator] spend priority expired — "${hold.reason}" went quiet ${Math.round(
        heldMs / 1000,
      )}s ago (held ${Math.round(
        (now - hold.since) / 1000,
      )}s); resuming item ingest and backup`,
    )
  }
  spendPriorityHolds = live
}

export type SpendPriorityLease = {
  /**
   * Prove the work is still alive. A BSV-21 mint that waits on proofs for an
   * unmined genesis can legitimately run past the expiry, and letting the hold
   * lapse under it invited chain ingest and history backup back on top of the
   * spend it was meant to protect. Expiry now catches abandoned holds only.
   */
  touch: () => void
  release: () => void
}

/**
 * Raise before enqueueing a spend so in-flight chain ingest can yield. Callers
 * that may run long should `touch()` while working; everyone else can use
 * `requestSpendPriority`.
 */
export function leaseSpendPriority(reason = 'spend'): SpendPriorityLease {
  dropExpiredSpendPriority()
  const now = Date.now()
  const hold: SpendPriorityHold = {
    id: nextSpendPriorityId++,
    reason,
    since: now,
    at: now,
  }
  spendPriorityHolds.push(hold)
  let released = false
  return {
    touch: () => {
      if (released) return
      hold.at = Date.now()
    },
    release: () => {
      if (released) return
      released = true
      spendPriorityHolds = spendPriorityHolds.filter((h) => h.id !== hold.id)
    },
  }
}

/**
 * Raise before enqueueing a spend so in-flight chain ingest can yield. Returns
 * the release — prefer it over `releaseSpendPriority()`, since it is idempotent
 * and releases the hold it created rather than whichever is oldest.
 */
export function requestSpendPriority(reason = 'spend'): () => void {
  return leaseSpendPriority(reason).release
}

/** Release the oldest hold. Kept for callers that cannot carry the releaser. */
export function releaseSpendPriority(): void {
  spendPriorityHolds = spendPriorityHolds.slice(1)
}

/** True while a send is queued or running — ingest should prefer funding-only. */
export function shouldYieldChainIngestToSpend(): boolean {
  dropExpiredSpendPriority()
  return spendPriorityHolds.length > 0
}

/** How many callers currently want the FIFO freed for a spend. */
export function getSpendPriorityDepth(): number {
  dropExpiredSpendPriority()
  return spendPriorityHolds.length
}

/** Who is holding spend priority right now — for Settings and stall reports. */
export function describeSpendPriorityHolds(): string[] {
  dropExpiredSpendPriority()
  const now = Date.now()
  // Report the real held time, not the last heartbeat — a stall report wants to
  // know how long the spend has been running.
  return spendPriorityHolds.map(
    (h) => `${h.reason} (${Math.round((now - h.since) / 1000)}s)`,
  )
}

export type WalletCoordinatorLiveStatus = WalletCoordinatorSnapshot & {
  spendWaiting: number
  /** Human one-liner for Settings / pill tooltips. */
  summary: string
}

/** Live coordinator view — use this instead of guessing which layer is stuck. */
export function describeWalletCoordinator(): WalletCoordinatorLiveStatus {
  const snap = getWalletCoordinatorSnapshot()
  const holders = describeSpendPriorityHolds()
  const spendWaiting = holders.length
  const active = (
    Object.entries(snap) as Array<[keyof WalletCoordinatorSnapshot, 'idle' | 'active']>
  )
    .filter(([, v]) => v === 'active')
    .map(([k]) => k)
  const parts: string[] = []
  if (active.length === 0) parts.push('layers idle')
  else parts.push(`active: ${active.join(', ')}`)
  if (spendWaiting > 0) parts.push(`spend waiting: ${holders.join(', ')}`)
  return {
    ...snap,
    spendWaiting,
    summary: parts.join(' · '),
  }
}

function context(): WalletCoordinatorContext {
  return actor.getSnapshot().context
}

export function getWalletCoordinatorSnapshot(): WalletCoordinatorSnapshot {
  return snapshotFromContext(context())
}

export function isRecomposeCoordinatorActive(): boolean {
  return context().recomposeDepth > 0
}

function waitFor(predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve()
  return new Promise((resolve) => {
    const sub = actor.subscribe(() => {
      if (predicate()) {
        sub.unsubscribe()
        resolve()
      }
    })
  })
}

async function acquire(
  event: WalletCoordinatorEvent,
  endEvent: WalletCoordinatorEvent,
  canBegin: () => boolean,
): Promise<() => void> {
  while (true) {
    const before = JSON.stringify(context())
    actor.send(event)
    const after = JSON.stringify(context())
    if (before !== after) break
    await waitFor(canBegin)
  }
  return () => {
    actor.send(endEvent)
  }
}

async function acquireChainIngest(nested: boolean): Promise<() => void> {
  return acquire(
    { type: 'CHAIN_INGEST_BEGIN', nested },
    { type: 'CHAIN_INGEST_END' },
    () => canBeginChainIngest(context(), nested),
  )
}

async function acquireSpend(): Promise<() => void> {
  return acquire({ type: 'SPEND_BEGIN' }, { type: 'SPEND_END' }, () => canBeginSpend(context()))
}

async function acquireHistoryReplica(): Promise<() => void> {
  return acquire(
    { type: 'HISTORY_BEGIN' },
    { type: 'HISTORY_END' },
    () => canBeginHistoryReplica(context()),
  )
}

async function acquireRecompose(): Promise<() => void> {
  return acquire(
    { type: 'RECOMPOSE_BEGIN' },
    { type: 'RECOMPOSE_END' },
    () => canBeginRecompose(context()),
  )
}

/**
 * Refresh / legacy import / migrate ingest — serialized within region; blocked
 * during spend (except nested spend heal) and historyReplica by the machine.
 */
export function runChainIngest<T>(fn: () => Promise<T>): Promise<T> {
  return chainIngestQueue(async () => {
    const release = await acquireChainIngest(false)
    try {
      return await fn()
    } finally {
      release()
    }
  })
}

/**
 * Spend-path chain heal — only while `runExclusiveSpend` holds the spend region.
 * Does not re-enter the chain ingest queue (avoids deadlock with in-flight send).
 */
export function runChainIngestDuringSpend<T>(fn: () => Promise<T>): Promise<T> {
  if (context().recomposeDepth > 0) {
    return fn()
  }
  if (context().spendDepth <= 0) {
    throw new Error('runChainIngestDuringSpend requires an active spend session')
  }
  return (async () => {
    const release = await acquireChainIngest(true)
    try {
      return await fn()
    } finally {
      release()
    }
  })()
}

/** Send / BRC spend paths — exclusive with chain ingest and history replica. */
export function runExclusiveSpend<T>(
  fn: () => Promise<T>,
  acquireLease: () => Promise<() => Promise<void>>,
  onSpendRegion?: () => void,
): Promise<T> {
  // Before the region waits — so a running refresh can yield ordinal work now.
  const priority = leaseSpendPriority('runExclusiveSpend')
  // A mint or a legacy sweep can outlive the expiry while doing real work. The
  // heartbeat is what separates that from a leaked hold.
  const heartbeat = setInterval(() => priority.touch(), SPEND_PRIORITY_TOUCH_MS)
  const releasePriority = () => {
    clearInterval(heartbeat)
    priority.release()
  }
  return spendQueue(async () => {
    try {
      const releaseSpend = await acquireSpend()
      // Region acquired — drop "Waiting to send…" before the cross-device lease RTT.
      onSpendRegion?.()
      const releaseLease = await acquireLease()
      try {
        return await fn()
      } finally {
        await releaseLease()
        releaseSpend()
      }
    } finally {
      releasePriority()
    }
  })
    .catch((err) => {
      // The queue itself can reject before the body runs; the hold must not survive it.
      releasePriority()
      throw err
    })
}

/**
 * Thrown when a historyReplica job yields to a waiting spend.
 * Auto-backup catches this and reschedules; manual Sync should retry.
 */
export class HistoryDeferredForSpendError extends Error {
  constructor() {
    super('Wallet backup paused — a payment is waiting')
    this.name = 'HistoryDeferredForSpendError'
  }
}

/**
 * Whether a historyReplica job steps aside for a spend that is merely *queued*.
 *
 * `yieldToSpend` is the default courtesy: Argon2id over a ~26MB BRC-38 must not
 * sit on the FIFO ahead of `createAction`. But the courtesy is unconditional, and
 * a spend raises its hold before it can acquire the region — so while chain
 * ingest is slow enough that sends queue for tens of seconds, back-to-back sends
 * keep the hint true and the balance snapshot never uploads at all.
 *
 * `starved` drops the hint for a caller that already waited out its deferral
 * budget. Region exclusion is owned by the machine either way, so the worst case
 * is a spend waiting on one export — never a spend running beside one.
 */
export type HistoryReplicaPriority = 'yieldToSpend' | 'starved'

/** BRC-39 push/pull/restore — exclusive with chain ingest and spend. */
export function runHistoryReplica<T>(
  fn: () => Promise<T>,
  priority: HistoryReplicaPriority = 'yieldToSpend',
): Promise<T> {
  if (context().recomposeDepth > 0) {
    return fn()
  }
  const yieldsToSpend = priority === 'yieldToSpend'
  const spendWantsIn = () => yieldsToSpend && shouldYieldChainIngestToSpend()
  return historyReplicaQueue(async () => {
    // Spends raise priority before enqueueing. Exit without holding history so
    // the waiting spend can acquire as soon as chain/history peers free the machine.
    while (true) {
      if (spendWantsIn()) {
        throw new HistoryDeferredForSpendError()
      }
      if (canBeginHistoryReplica(context())) break
      await waitFor(() => canBeginHistoryReplica(context()) || spendWantsIn())
    }
    if (spendWantsIn()) {
      throw new HistoryDeferredForSpendError()
    }
    const release = await acquireHistoryReplica()
    try {
      if (spendWantsIn()) {
        throw new HistoryDeferredForSpendError()
      }
      return await fn()
    } finally {
      release()
    }
  })
}

/** Unlock / restore recompose — owns the session; internal history + chain skip sub-acquires. */
export function runRecompose<T>(fn: () => Promise<T>): Promise<T> {
  return recomposeQueue(async () => {
    const release = await acquireRecompose()
    try {
      return await fn()
    } finally {
      release()
    }
  })
}
