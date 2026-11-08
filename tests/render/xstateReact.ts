/**
 * Render harness stand-in for `@xstate/react`. `useMachine` starts a machine in
 * the snapshot the fixture declares (via `machine.resolveState`), so no events
 * run and no invoked work starts, and mirrors the live snapshot to
 * `window.__renderStates` for the runner to verify.
 */
import { useEffect, useMemo } from 'react'
import { useMachine as realUseMachine } from '@xstate/react'
import { createActor, type AnyStateMachine } from 'xstate'
import { machineState, recordState, stateKey } from './mockState'

export * from '@xstate/react'

function restoredSnapshot(machine: AnyStateMachine, options: Record<string, unknown> | undefined) {
  const declared = machineState(machine.id)
  if (!declared) return undefined
  // Real initial context for this input (keeps ports and defaults), then the fixture's fields.
  const initial = createActor(machine, { input: options?.input }).getSnapshot().context as Record<string, unknown>
  return machine.resolveState({ value: declared.value as never, context: { ...initial, ...declared.context } })
}

export const useMachine = ((machine: AnyStateMachine, options?: Record<string, unknown>) => {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a fixture's state is fixed for the page
  const snapshot = useMemo(() => restoredSnapshot(machine, options), [machine])
  const result = (realUseMachine as (m: unknown, o?: unknown) => ReturnType<typeof realUseMachine>)(
    machine,
    snapshot ? { ...options, snapshot } : options,
  )
  const [state, , actor] = result
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one key per mounted actor
  const key = useMemo(() => stateKey(machine.id), [actor])
  useEffect(() => recordState(key, state.value, state.context), [key, state])
  useEffect(() => {
    const sub = actor.subscribe((next) => recordState(key, next.value, next.context))
    return () => sub.unsubscribe()
  }, [actor, key])
  return result
}) as typeof realUseMachine
