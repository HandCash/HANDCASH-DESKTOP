/**
 * Live actions: one `actionLifecycleMachine` actor per action the wallet is
 * running right now, keyed by the same id its durable Activity row will carry.
 *
 * The bridge starts one per request (`action:<request_id>`); wallet sends start
 * one through `paymentProgress` and adopt their `pendingId` the moment the
 * durable row is written. Activity, the status pill and inventory badges read
 * the same snapshots, so every surface agrees on which phase an action is in.
 *
 * Nothing here knows whether an action is a mint, a listing or a payment. The
 * verb lives on the row; the phase lives here.
 */
import { createActor, type Actor } from 'xstate'
import {
  ACTION_STAGES,
  actionLifecycleFace,
  actionLifecycleMachine,
  actionProgress,
  type ActionLifecycleFace,
  type ActionLifecycleInput,
  type ActionStage,
} from '../machines/actionLifecycleMachine'

export type LiveAction = {
  id: string
  origin: string
  method: string
  description: string | null
  txid: string | null
  /** Dotted `txid.vout`, lower-case. */
  outpoints: readonly string[]
  startedAt: number
  face: ActionLifecycleFace
  error: string | null
  progress: { value: number; max: number } | null
}

export type ActionHandle = {
  readonly id: string
  stage(stage: ActionStage): void
  txid(txid: string): void
  touch(outpoints: readonly string[]): void
  settle(): void
  fail(reason: string): void
  view(): LiveAction
}

type Entry = {
  actor: Actor<typeof actionLifecycleMachine>
  retire: ReturnType<typeof setTimeout> | null
  watchdog: ReturnType<typeof setTimeout> | null
}

/** Settled actions leave once their durable row has had a beat to land. */
const SETTLED_RETIRE_MS = 1_500
/** Failures stay long enough to be read, then the durable failed row (if any) speaks. */
const FAILED_RETIRE_MS = 8_000
/** No phase may run this long without progress once the user has approved. */
export const ACTION_STUCK_MS = 90_000

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
let views: readonly LiveAction[] = []

function project(actor: Actor<typeof actionLifecycleMachine>): LiveAction {
  const snapshot = actor.getSnapshot()
  const c = snapshot.context
  return {
    id: c.id,
    origin: c.origin,
    method: c.method,
    description: c.description,
    txid: c.txid,
    outpoints: c.outpoints,
    startedAt: c.startedAt,
    face: actionLifecycleFace(snapshot),
    error: c.error,
    progress: actionProgress(snapshot),
  }
}

function publish(): void {
  views = Object.freeze(
    Array.from(entries.values(), (entry) => project(entry.actor)).sort(
      (a, b) => b.startedAt - a.startedAt
    )
  )
  for (const listener of listeners) listener()
}

function drop(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  if (entry.retire) clearTimeout(entry.retire)
  if (entry.watchdog) clearTimeout(entry.watchdog)
  entry.actor.stop()
  entries.delete(id)
  publish()
}

function scheduleRetire(id: string, ms: number): void {
  const entry = entries.get(id)
  if (!entry) return
  if (entry.retire) clearTimeout(entry.retire)
  entry.retire = setTimeout(() => drop(id), ms)
}

function armWatchdog(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  if (entry.watchdog) clearTimeout(entry.watchdog)
  entry.watchdog = null
  const face = actionLifecycleFace(entry.actor.getSnapshot())
  // Approval is the user's time; every other live phase is the wallet's.
  if (face === 'approving' || face === 'settled' || face === 'failed') return
  entry.watchdog = setTimeout(() => {
    const live = entries.get(id)
    if (!live) return
    live.watchdog = null
    const stuck = actionLifecycleFace(live.actor.getSnapshot())
    if (stuck === 'settled' || stuck === 'failed') return
    console.warn('[action-lifecycle] stuck — failing', id, stuck)
    live.actor.send({ type: 'FAIL', reason: `Timed out while ${stuck}` })
    scheduleRetire(id, FAILED_RETIRE_MS)
    publish()
  }, ACTION_STUCK_MS)
}

function handleFor(id: string): ActionHandle {
  const send = (event: Parameters<Actor<typeof actionLifecycleMachine>['send']>[0]) => {
    const entry = entries.get(id)
    if (!entry) return
    entry.actor.send(event)
    const face = actionLifecycleFace(entry.actor.getSnapshot())
    if (face === 'settled') scheduleRetire(id, SETTLED_RETIRE_MS)
    else if (face === 'failed') scheduleRetire(id, FAILED_RETIRE_MS)
    armWatchdog(id)
    publish()
  }
  return {
    id,
    stage: (stage) => send({ type: 'STAGE', stage }),
    txid: (txid) => send({ type: 'TXID', txid }),
    touch: (outpoints) => send({ type: 'TOUCH', outpoints }),
    settle: () => send({ type: 'SETTLE' }),
    fail: (reason) => send({ type: 'FAIL', reason }),
    view: () => {
      const entry = entries.get(id)
      if (entry) return project(entry.actor)
      return {
        id,
        origin: '',
        method: '',
        description: null,
        txid: null,
        outpoints: [],
        startedAt: 0,
        face: 'settled',
        error: null,
        progress: null,
      }
    },
  }
}

/**
 * Start a lifecycle. Starting an id that is already live replaces it — a retried
 * request is a new run, and the old actor would only lie about it.
 */
export function beginAction(
  input: ActionLifecycleInput & { stage?: ActionStage }
): ActionHandle {
  if (entries.has(input.id)) drop(input.id)
  const actor = createActor(actionLifecycleMachine, { input })
  actor.start()
  entries.set(input.id, { actor, retire: null, watchdog: null })
  const handle = handleFor(input.id)
  if (input.stage && input.stage !== 'approving') handle.stage(input.stage)
  else {
    armWatchdog(input.id)
    publish()
  }
  return handle
}

/** Lifecycle id for a bridge request; the durable row it produces shares it. */
export function bridgeActionId(requestId: number | string): string {
  return `action:${requestId}`
}

/** Forget an action without a verdict — a denial is the user's choice, not a failure. */
export function dismissAction(id: string): void {
  drop(id)
}

/** Handle for a live action, or null once it has retired. */
export function liveAction(id: string): ActionHandle | null {
  return entries.has(id) ? handleFor(id) : null
}

/**
 * Give a live action the id its durable row uses. Wallet sends start under a
 * provisional id before their `pendingId` exists; adopting joins the two
 * without any matching by time or amount.
 */
export function adoptActionId(fromId: string, toId: string): ActionHandle | null {
  if (fromId === toId) return liveAction(toId)
  const entry = entries.get(fromId)
  if (!entry) return null
  if (entries.has(toId)) drop(toId)
  entries.delete(fromId)
  entries.set(toId, entry)
  // The actor's own context keeps the id it was born with; rebuild it so the
  // projection and the map agree.
  const snapshot = entry.actor.getSnapshot()
  const replacement = createActor(actionLifecycleMachine, {
    input: {
      id: toId,
      origin: snapshot.context.origin,
      method: snapshot.context.method,
      description: snapshot.context.description,
      outpoints: snapshot.context.outpoints,
      startedAt: snapshot.context.startedAt,
    },
  })
  replacement.start()
  const face = actionLifecycleFace(snapshot)
  if (ACTION_STAGES.includes(face as ActionStage) && face !== 'approving') {
    replacement.send({ type: 'STAGE', stage: face as ActionStage })
  }
  if (snapshot.context.txid) replacement.send({ type: 'TXID', txid: snapshot.context.txid })
  entry.actor.stop()
  entry.actor = replacement
  armWatchdog(toId)
  publish()
  return handleFor(toId)
}

/**
 * The wallet's own exclusive spend. `paymentProgress` starts it under a
 * provisional id; `noteOutboundSendPending` renames it to the row's pendingId.
 */
let walletActionId: string | null = null

export function beginWalletAction(
  input: Omit<ActionLifecycleInput, 'id'> & { stage?: ActionStage }
): ActionHandle {
  if (walletActionId) drop(walletActionId)
  const id = `wallet:${input.startedAt ?? Date.now()}`
  walletActionId = id
  return beginAction({ ...input, id })
}

export function walletAction(): ActionHandle | null {
  return walletActionId ? liveAction(walletActionId) : null
}

export function adoptWalletActionId(pendingId: string): ActionHandle | null {
  if (!walletActionId) return null
  const handle = adoptActionId(walletActionId, pendingId)
  if (handle) walletActionId = pendingId
  return handle
}

/** The wallet's spend is over; the durable row carries on from here. */
export function endWalletAction(outcome: 'settled' | { failed: string }): void {
  const handle = walletAction()
  walletActionId = null
  if (!handle) return
  if (outcome === 'settled') handle.settle()
  else handle.fail(outcome.failed)
}

export function listLiveActions(): readonly LiveAction[] {
  return views
}

export function liveActionView(id: string): LiveAction | null {
  const entry = entries.get(id)
  return entry ? project(entry.actor) : null
}

export function liveActionForTxid(txid: string): LiveAction | null {
  const key = txid.trim().toLowerCase()
  return views.find((view) => view.txid === key) ?? null
}

export function liveActionForOutpoint(outpoint: string): LiveAction | null {
  const key = outpoint.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
  return views.find((view) => view.outpoints.includes(key)) ?? null
}

/** Any action past approval and not yet finished. */
export function hasBusyAction(): boolean {
  return views.some(
    (view) => view.face !== 'approving' && view.face !== 'settled' && view.face !== 'failed'
  )
}

export function subscribeLiveActions(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam: forget every live action. */
export function resetLiveActionsForTests(): void {
  walletActionId = null
  for (const id of Array.from(entries.keys())) drop(id)
}
