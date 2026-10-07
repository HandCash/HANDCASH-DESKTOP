import { assign, setup, type SnapshotFrom } from 'xstate'

/**
 * Chart: walletJob
 * States: running ⇄ waiting → done | stopped | failed
 *
 * One long wallet job — an item import run, a saved-wallet sweep, a balance
 * heal — that spans many transactions or chain reads and keeps going after
 * its screen closes.
 * `actionLifecycleMachine` is one transaction's phases; a job is the work
 * around many of them, so it carries a count instead of a phase.
 *
 * Activity paints the job as one row with a bar while it runs. When it ends,
 * the durable rows it wrote fold into one record under the job's group id.
 */
export type WalletJobKind = 'item-import' | 'wallet-sweep' | 'balance-heal'

/** Job ids start here; they double as the `sendGroupId` of every row a job writes. */
export const JOB_GROUP_PREFIX = 'job:'

export type WalletJobEvent =
  | { type: 'PROGRESS'; current: number; total: number | null; detail?: string | null }
  | { type: 'WAIT'; detail: string }
  | { type: 'RESUME' }
  | { type: 'FINISH'; detail?: string | null }
  | { type: 'STOP'; detail?: string | null }
  | { type: 'FAIL'; reason: string }

export type WalletJobContext = {
  /** Also the `sendGroupId` of every Activity row the job writes. */
  id: string
  kind: WalletJobKind
  /** Vault identity the job belongs to; other accounts never see it. */
  identityKey: string
  current: number
  /** Unknown until the job can estimate it; the bar runs indeterminate meanwhile. */
  total: number | null
  detail: string | null
  startedAt: number
  error: string | null
}

export type WalletJobInput = {
  id: string
  kind: WalletJobKind
  identityKey: string
  total?: number | null
  detail?: string | null
  startedAt?: number
}

const count = (n: number) => Math.max(0, Math.trunc(n))

export const walletJobMachine = setup({
  types: {
    context: {} as WalletJobContext,
    events: {} as WalletJobEvent,
    input: {} as WalletJobInput,
  },
  actions: {
    progress: assign(({ event, context }) =>
      event.type === 'PROGRESS'
        ? {
            current: count(event.current),
            total: event.total == null ? null : count(event.total),
            detail: event.detail === undefined ? context.detail : event.detail?.trim() || null,
          }
        : {},
    ),
    detail: assign(({ event, context }) =>
      event.type === 'WAIT' || event.type === 'FINISH' || event.type === 'STOP'
        ? { detail: event.detail === undefined ? context.detail : event.detail?.trim() || null }
        : {},
    ),
    fail: assign(({ event }) => (event.type === 'FAIL' ? { error: event.reason } : {})),
  },
}).createMachine({
  id: 'walletJob',
  initial: 'running',
  context: ({ input }) => ({
    id: input.id,
    kind: input.kind,
    identityKey: input.identityKey,
    current: 0,
    total: input.total == null ? null : count(input.total),
    detail: input.detail?.trim() || null,
    startedAt: input.startedAt ?? Date.now(),
    error: null,
  }),
  on: {
    PROGRESS: { actions: 'progress' },
  },
  states: {
    running: {
      on: {
        WAIT: { target: 'waiting', actions: 'detail' },
        FINISH: { target: 'done', actions: 'detail' },
        STOP: { target: 'stopped', actions: 'detail' },
        FAIL: { target: 'failed', actions: 'fail' },
      },
    },
    /** Held by something outside the job: a fee coin clearing, another layer's lock. */
    waiting: {
      on: {
        RESUME: 'running',
        PROGRESS: { target: 'running', actions: 'progress' },
        FINISH: { target: 'done', actions: 'detail' },
        STOP: { target: 'stopped', actions: 'detail' },
        FAIL: { target: 'failed', actions: 'fail' },
      },
    },
    done: { type: 'final' },
    /** The user stopped it, or the wallet ran out of something to spend. */
    stopped: { type: 'final' },
    failed: { type: 'final' },
  },
})

export type WalletJobSnapshot = SnapshotFrom<typeof walletJobMachine>

export type WalletJobFace = 'running' | 'waiting' | 'done' | 'stopped' | 'failed'

export function walletJobFace(snapshot: WalletJobSnapshot): WalletJobFace {
  return snapshot.value as WalletJobFace
}

/** Bar projection; null while the total is unknown (indeterminate). */
export function walletJobProgress(
  snapshot: WalletJobSnapshot,
): { value: number; max: number } | null {
  const { current, total } = snapshot.context
  const known = total != null && total > 0
  if (snapshot.matches('done')) return known ? { value: total, max: total } : { value: 1, max: 1 }
  if (!known) return null
  return { value: Math.min(current, total), max: total }
}
