import { useMachine } from '@xstate/solid'
import type { AnyStateMachine } from 'xstate'

/** Bridge executable statecharts to Solid — UI = f(snapshot). */
export function useAeonMachine<M extends AnyStateMachine>(
  machine: M,
  options?: Parameters<typeof useMachine<M>>[1],
) {
  return useMachine(machine, options)
}
