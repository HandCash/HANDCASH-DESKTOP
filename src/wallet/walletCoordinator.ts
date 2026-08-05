/**
 * Runtime for `walletCoordinatorMachine` — single FIFO entry for wallet-layer work.
 * Replaces ad-hoc serial queues on chainIngest / spend / historyReplica.
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

const topLevelQueue = createSerialQueue()

let actor: Actor<typeof walletCoordinatorMachine> = createActor(walletCoordinatorMachine).start()

/** Test-only — reset coordinator between cases. */
export function resetWalletCoordinatorForTests(): void {
  actor.stop()
  actor = createActor(walletCoordinatorMachine).start()
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
 * Refresh / legacy import / migrate ingest — serialized; blocked during spend
 * (except nested spend heal) and historyReplica.
 */
export function runChainIngest<T>(fn: () => Promise<T>): Promise<T> {
  if (context().recomposeDepth > 0) {
    return fn()
  }
  return topLevelQueue(async () => {
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
 * Does not re-enter the top-level queue (avoids deadlock with in-flight send).
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
): Promise<T> {
  return topLevelQueue(async () => {
    const releaseSpend = await acquireSpend()
    const releaseLease = await acquireLease()
    try {
      return await fn()
    } finally {
      await releaseLease()
      releaseSpend()
    }
  })
}

/** BRC-39 push/pull/restore — exclusive with chain ingest and spend. */
export function runHistoryReplica<T>(fn: () => Promise<T>): Promise<T> {
  if (context().recomposeDepth > 0) {
    return fn()
  }
  return topLevelQueue(async () => {
    const release = await acquireHistoryReplica()
    try {
      return await fn()
    } finally {
      release()
    }
  })
}

/** Unlock / restore recompose — owns the session; internal history + chain skip sub-acquires. */
export function runRecompose<T>(fn: () => Promise<T>): Promise<T> {
  return topLevelQueue(async () => {
    const release = await acquireRecompose()
    try {
      return await fn()
    } finally {
      release()
    }
  })
}

/** @deprecated use runChainIngest */
export const runOnChainIngestQueue = runChainIngest

/** @deprecated use runHistoryReplica */
export const runOnHistoryReplicaQueue = runHistoryReplica
