import { assign, fromCallback, setup } from 'xstate'
import type {
  SettingsPreferencePath, SettingsPreferences, SettingsPreferencesPort,
} from '../wallet/settingsPreferences'

type Events =
  | { type: 'CHOOSE'; path: SettingsPreferencePath }
  | { type: 'SYNC'; preferences: SettingsPreferences }

/** Settings preferences are immediately durable; other Settings flows keep their own charts. */
export const settingsPreferencesMachine = setup({
  types: {
    context: {} as SettingsPreferences & { port: SettingsPreferencesPort },
    input: {} as { port: SettingsPreferencesPort },
    events: {} as Events,
  },
  actors: {
    watch: fromCallback<Events, SettingsPreferencesPort>(({ input, sendBack }) => {
      const sync = () => sendBack({ type: 'SYNC', preferences: input.read() })
      const stop = input.subscribe(sync)
      sync() // Reconcile any write between initial read and subscription.
      return stop
    }),
  },
  actions: {
    choose: ({ context, event }) => {
      if (event.type === 'CHOOSE') context.port.choose(event.path)
    },
    read: assign(({ context }) => context.port.read()),
    sync: assign(({ event }) => event.type === 'SYNC' ? event.preferences : {}),
  },
}).createMachine({
  id: 'settingsPreferences',
  context: ({ input }) => ({ port: input.port, ...input.port.read() }),
  initial: 'ready',
  invoke: { src: 'watch', input: ({ context }) => context.port },
  states: {
    ready: {
      on: {
        CHOOSE: { actions: ['choose', 'read'] },
        SYNC: { actions: 'sync' },
      },
    },
  },
})
