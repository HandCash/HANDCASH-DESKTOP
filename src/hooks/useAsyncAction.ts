import { useCallback, useMemo, useRef } from 'react'
import { useActorRef, useSelector } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import {
  asyncActionMachine,
  type AsyncActionConfirm,
} from '../machines/asyncActionMachine'

export type { AsyncActionConfirm }

export type AsyncActionOutcome =
  | { ok: true }
  | { ok: false; error: string }
  /** Another action was in flight, or the user cancelled the confirm step. */
  | { ok: false; error: null; refused: true }

export type AsyncActionHandle<Kind extends string = string> = {
  /** `idle` | `confirming` | `busy` | `failure` — project straight onto `data-aeon-state`. */
  stateAttr: string
  /** True while a mutation runs or awaits confirmation; every sibling button disables on this. */
  busy: boolean
  /** Action awaiting confirmation, in flight, or the one that last failed. */
  action: Kind | null
  /** Copy for the open Prompt, or null when nothing awaits confirmation. */
  confirm: AsyncActionConfirm | null
  /** Reason for the last failure, until the next START or RESET. */
  error: string | null
  /** Is this specific action the one running now? Drives "Saving…" labels. */
  running: (kind: Kind) => boolean
  /**
   * Run `task` as `kind`. With `confirm`, the chart enters `confirming` and the
   * task only runs after the Prompt's primary fires. Refused (no-op) when
   * another action is in flight or the user cancels; otherwise resolves after
   * the chart has recorded success or failure. The caller keeps its own
   * toasts / sounds / navigation off the outcome.
   */
  run: (
    kind: Kind,
    task: () => Promise<void>,
    options?: { confirm?: AsyncActionConfirm },
  ) => Promise<AsyncActionOutcome>
  /** Prompt primary. */
  confirmPending: () => void
  /** Prompt secondary / backdrop. */
  cancelPending: () => void
  /** Drop a stale failure, e.g. when the panel's subject changes. */
  reset: () => void
}

/** Failure message as the chart stores it. */
export function asyncActionError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Projection of `asyncActionMachine` for a panel: one exclusive mutation at a
 * time, named, confirmed through a chart state rather than `window.confirm`,
 * with its failure reason kept in the chart. Replaces
 * `const [busy, setBusy] = useState(false)` + `try/finally`.
 */
export function useAsyncAction<Kind extends string = string>(): AsyncActionHandle<Kind> {
  const actor = useActorRef(asyncActionMachine)
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

  const run = useCallback<AsyncActionHandle<Kind>['run']>(
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
      // The task may navigate away (unmounting this panel) before it settles;
      // a stopped actor takes no events, and the caller still gets the outcome.
      const alive = () => actor.getSnapshot().status === 'active'
      try {
        await task()
        if (alive()) actor.send({ type: 'SUCCEED' })
        return { ok: true }
      } catch (err) {
        const error = asyncActionError(err)
        if (alive()) actor.send({ type: 'FAIL', error })
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
      action: action as Kind | null,
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

/** Named mutations on an Activity row or the Activity list. */
export type ActivityActionKind =
  | 'retry'
  | 'clear'
  | 'release'
  | 'reclaim'
  | 'cancelListing'
  | 'rebroadcastAll'
  | 'clearAll'
  | 'publishPending'

export const useActivityAction = () => useAsyncAction<ActivityActionKind>()
