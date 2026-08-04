import { createActor, type AnyStateMachine, type Actor, type Subscription } from 'xstate'

export interface AeonMachineHandle<M extends AnyStateMachine> {
  actor: Actor<M>
  send: Actor<M>['send']
  getSnapshot: () => ReturnType<Actor<M>['getSnapshot']>
  subscribe: (listener: (snapshot: ReturnType<Actor<M>['getSnapshot']>) => void) => Subscription
}

/** XState actor wired for Svelte 5 runes ($effect + $state). */
export function useAeonMachine<M extends AnyStateMachine>(
  machine: M,
  options?: Parameters<typeof createActor<M>>[1],
): AeonMachineHandle<M> {
  const actor = createActor(machine, options)
  actor.start()
  return {
    actor,
    send: actor.send.bind(actor),
    getSnapshot: () => actor.getSnapshot(),
    subscribe: (listener) => actor.subscribe(listener),
  }
}
