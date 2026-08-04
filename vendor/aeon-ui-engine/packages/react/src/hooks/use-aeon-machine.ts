import { useMachine } from '@xstate/react'
import type { AnyStateMachine } from 'xstate'

/** Bridge executable statecharts to React — UI = f(snapshot). */
export function useAeonMachine<M extends AnyStateMachine>(
  machine: M,
  options?: Parameters<typeof useMachine<M>>[1],
) {
  return useMachine(machine, options)
}
