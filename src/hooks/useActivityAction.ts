import { useCallback, useMemo, useRef } from 'react'
import { useActorRef, useSelector } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import {
  activityActionMachine,
  type ActivityActionConfirm,
  type ActivityActionKind,
} from '../machines/activityActionMachine'

export type ActivityActionOutcome =
  | { ok: true }
  | { ok: false; error: string }
  /** Another action was in flight, or the user cancelled the confirm step. */
  | { ok: false; error: null; refused: true }

export type ActivityActionHandle = {
  /** `idle` | `confirming` | `busy` | `failure` — project straight onto `data-aeon-state`. */
  stateAttr: string
  /** True while a mutation runs or awaits confirmation; every sibling button disables on this. */
  busy: boolean
  /** Action awaiting confirmation, in flight, or the one that last failed. */
  action: ActivityActionKind | null
  /** Copy for the open Prompt, or null when nothing awaits confirmation. */
  confirm: ActivityActionConfirm | null
  /** Reason for the last failure, until the next START or RESET. */
  error: string | null
  /** Is this specific action the one running now? Drives "Clearing…" labels. */
  running: (kind: ActivityActionKind) => boolean
  /**
   * Run `task` as `kind`. With `confirm`, the chart enters `confirming` and the
   * task only runs after the Prompt's primary fires. Refused (no-op) when
   * another action is in flight or the user cancels; otherwise resolves after
   * the chart has recorded success or failure. The caller keeps its own
   * toasts / sounds / re-classification off the outcome.
   */
  run: (
    kind: ActivityActionKind,
    task: () => Promise<void>,
    options?: { confirm?: ActivityActionConfirm },
  ) => Promise<ActivityActionOutcome>
  /** Prompt primary. */
  confirmPending: () => void
  /** Prompt secondary / backdrop. */
  cancelPending: () => void
  /** Drop a stale failure, e.g. when the panel's subject row changes. */
  reset: () => void
}

/**
 * Projection of `activityActionMachine` for Activity panels: one exclusive
 * mutation at a time, named, confirmed through a chart state rather than
 * `window.confirm`, with its failure reason kept in the chart.
 */
export function useActivityAction(): ActivityActionHandle {
  const actor = useActorRef(activityActionMachine)
  const snapshot = useSelector(actor, (s) => s)
  const decision = useRef<((confirmed: boolean) => void) | null>(null)

  const settle = useCallback((confirmed: boolean) => {
    const resolve = decision.current
    decision.current = null
    resolve?.(confirmed)
  }, [])

  const confirmPending = useCallback(() => {
    if (!actor.getSnapshot().matches('confirming')) return
    actor.send({ type: 'CONFIRM' })
    settle(true)
  }, [actor, settle])

  const cancelPending = useCallback(() => {
    if (!actor.getSnapshot().matches('confirming')) return
    actor.send({ type: 'CANCEL' })
    settle(false)
  }, [actor, settle])

  const run = useCallback<ActivityActionHandle['run']>(
    async (kind, task, options) => {
      const current = actor.getSnapshot()
      if (current.matches('busy') || current.matches('confirming')) {
        return { ok: false, error: null, refused: true }
      }
      if (options?.confirm) {
        actor.send({ type: 'REQUEST', action: kind, confirm: options.confirm })
        const confirmed = await new Promise<boolean>((resolve) => {
          decision.current = resolve
        })
        if (!confirmed) return { ok: false, error: null, refused: true }
      } else {
        actor.send({ type: 'START', action: kind })
      }
      try {
        await task()
        actor.send({ type: 'SUCCEED' })
        return { ok: true }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        actor.send({ type: 'FAIL', error })
        return { ok: false, error }
      }
    },
    [actor],
  )

  const reset = useCallback(() => {
    // A RESET while confirming also releases the awaiting caller.
    if (actor.getSnapshot().matches('confirming')) settle(false)
    actor.send({ type: 'RESET' })
  }, [actor, settle])

  return useMemo(() => {
    const busy = snapshot.matches('busy') || snapshot.matches('confirming')
    const { action, confirm, error } = snapshot.context
    return {
      stateAttr: stateToAttr(snapshot.value),
      busy,
      action,
      confirm,
      error,
      running: (kind) => snapshot.matches('busy') && action === kind,
      run,
      confirmPending,
      cancelPending,
      reset,
    }
  }, [snapshot, run, confirmPending, cancelPending, reset])
}
