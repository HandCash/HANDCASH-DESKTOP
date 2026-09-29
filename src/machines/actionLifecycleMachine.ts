import { assign, setup, type SnapshotFrom } from 'xstate'

/**
 * Chart: actionLifecycle
 * States: approving → preparing → signing → broadcasting → settling → settled
 *                                                                    ↘ failed
 *
 * One lifecycle for every action that can end in a transaction: an app's
 * `createAction`, a wallet send, a listing, a burn, a receive. The chart knows
 * nothing about which of those it is. It knows the phases the wallet actually
 * passes through, in order, and it keeps the facts that identify the action
 * once it is over: the txid, the outputs it touched, why it failed.
 *
 * Activity projects this chart while the action runs and the settlement record
 * (`txLifecycleMachine`) once it has a txid. Nothing else paints a phase.
 */
export const ACTION_STAGES = [
  'approving',
  'preparing',
  'signing',
  'broadcasting',
  'settling',
] as const

export type ActionStage = (typeof ACTION_STAGES)[number]

export const ACTION_STAGE_LABELS: Readonly<Record<ActionStage, string>> = {
  approving: 'Approving',
  preparing: 'Preparing',
  signing: 'Signing',
  broadcasting: 'Broadcasting',
  settling: 'Verifying',
}

export type ActionLifecycleEvent =
  | { type: 'STAGE'; stage: ActionStage }
  | { type: 'TXID'; txid: string }
  | { type: 'TOUCH'; outpoints: readonly string[] }
  | { type: 'SETTLE' }
  | { type: 'FAIL'; reason: string }

export type ActionLifecycleContext = {
  /** Stable identity for the whole run: `action:<requestId>` or a send's pendingId. */
  id: string
  /** App origin or the wallet's own origin. */
  origin: string
  /** BRC-100 method or wallet verb — a label, never a branch. */
  method: string
  /** What the user approved, as the prompt showed it. */
  description: string | null
  txid: string | null
  /** Outputs this action spends or creates that the wallet cares about (`txid.vout`). */
  outpoints: readonly string[]
  startedAt: number
  error: string | null
}

export type ActionLifecycleInput = {
  id: string
  origin: string
  method: string
  description?: string | null
  outpoints?: readonly string[]
  startedAt?: number
}

const isStage =
  (stage: ActionStage) =>
  ({ event }: { event: ActionLifecycleEvent }) =>
    event.type === 'STAGE' && event.stage === stage

/** Every live stage routes `STAGE` the same way; order is the domain's, not the chart's. */
const stageOn = {
  STAGE: [
    { target: 'approving', guard: 'isApproving' },
    { target: 'preparing', guard: 'isPreparing' },
    { target: 'signing', guard: 'isSigning' },
    { target: 'broadcasting', guard: 'isBroadcasting' },
    { target: 'settling', guard: 'isSettling' },
  ],
  TXID: { actions: 'txid' },
  TOUCH: { actions: 'touch' },
  SETTLE: { target: '#actionLifecycle.settled' },
  FAIL: { target: '#actionLifecycle.failed', actions: 'fail' },
} as const

export const actionLifecycleMachine = setup({
  types: {
    context: {} as ActionLifecycleContext,
    events: {} as ActionLifecycleEvent,
    input: {} as ActionLifecycleInput,
  },
  guards: {
    isApproving: isStage('approving'),
    isPreparing: isStage('preparing'),
    isSigning: isStage('signing'),
    isBroadcasting: isStage('broadcasting'),
    isSettling: isStage('settling'),
  },
  actions: {
    txid: assign(({ event }) =>
      event.type === 'TXID' ? { txid: event.txid.trim().toLowerCase() } : {}
    ),
    touch: assign(({ event, context }) =>
      event.type === 'TOUCH'
        ? {
            outpoints: Array.from(
              new Set([...context.outpoints, ...event.outpoints.map(normalizeOutpoint)])
            ),
          }
        : {}
    ),
    fail: assign(({ event }) => (event.type === 'FAIL' ? { error: event.reason } : {})),
  },
}).createMachine({
  id: 'actionLifecycle',
  initial: 'approving',
  context: ({ input }) => ({
    id: input.id,
    origin: input.origin,
    method: input.method,
    description: input.description?.trim() || null,
    txid: null,
    outpoints: (input.outpoints ?? []).map(normalizeOutpoint),
    startedAt: input.startedAt ?? Date.now(),
    error: null,
  }),
  states: {
    /** The prompt is up, or auto-pay is deciding. Nothing has been built. */
    approving: { on: stageOn },
    /** Funds checked, inputs chosen, scripts enriched. Still nothing signed. */
    preparing: { on: stageOn },
    /** Keys are producing signatures. */
    signing: { on: stageOn },
    /** Handed to the network. A txid exists from here on. */
    broadcasting: { on: stageOn },
    /** The wallet is filing what it now holds: baskets, provenance, activity. */
    settling: { on: stageOn },
    settled: { type: 'final' },
    failed: { type: 'final' },
  },
})

export type ActionLifecycleSnapshot = SnapshotFrom<typeof actionLifecycleMachine>

/** Row token for CSS and copy — a live stage, or how it ended. */
export type ActionLifecycleFace = ActionStage | 'settled' | 'failed'

export function actionLifecycleFace(snapshot: ActionLifecycleSnapshot): ActionLifecycleFace {
  return snapshot.value as ActionLifecycleFace
}

/** Index of the live stage; stage count once settled; null when failed. */
export function actionStageIndex(snapshot: ActionLifecycleSnapshot): number | null {
  if (snapshot.matches('settled')) return ACTION_STAGES.length
  if (snapshot.matches('failed')) return null
  const index = ACTION_STAGES.indexOf(snapshot.value as ActionStage)
  return index < 0 ? null : index
}

/** Bar projection: the live stage counts as half done; settled fills it. */
export function actionProgress(
  snapshot: ActionLifecycleSnapshot
): { value: number; max: number } | null {
  const index = actionStageIndex(snapshot)
  if (index == null) return null
  const max = ACTION_STAGES.length
  return { value: snapshot.matches('settled') ? max : index + 0.5, max }
}

function normalizeOutpoint(outpoint: string): string {
  return outpoint.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
}
