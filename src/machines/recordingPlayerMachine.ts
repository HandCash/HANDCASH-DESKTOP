import { assign, fromPromise, setup } from 'xstate'
import type { OpenedRecording } from '../wallet/calls/recordingStore'

export type RecordingPlayerPorts = {
  open: (id: string) => Promise<OpenedRecording | null>
  remove: (id: string) => Promise<void>
}

type Input = { id: string; ports: RecordingPlayerPorts }

/**
 * Chart: recordingPlayer — one call recording opened on its Activity row.
 * opening (read its sealed parts and unseal them in memory) → ready, gone
 * (not on this device) or failed; ready → deleting → deleted, or failed.
 */
export const recordingPlayerMachine = setup({
  types: {
    context: {} as Input & { opened: OpenedRecording | null },
    input: {} as Input,
    events: {} as { type: 'DELETE' },
  },
  actors: {
    open: fromPromise(({ input }: { input: Input }) => input.ports.open(input.id)),
    remove: fromPromise(({ input }: { input: Input }) => input.ports.remove(input.id)),
  },
}).createMachine({
  id: 'recordingPlayer',
  initial: 'opening',
  context: ({ input }) => ({ ...input, opened: null }),
  states: {
    opening: {
      invoke: {
        src: 'open',
        input: ({ context }) => ({ id: context.id, ports: context.ports }),
        onDone: [
          { guard: ({ event }) => event.output !== null, target: 'ready', actions: assign({ opened: ({ event }) => event.output }) },
          { target: 'gone' },
        ],
        onError: 'failed',
      },
    },
    ready: { on: { DELETE: 'deleting' } },
    deleting: {
      invoke: {
        src: 'remove',
        input: ({ context }) => ({ id: context.id, ports: context.ports }),
        onDone: { target: 'deleted', actions: assign({ opened: null }) },
        onError: 'failed',
      },
    },
    gone: {},
    failed: {},
    deleted: { type: 'final' },
  },
})
