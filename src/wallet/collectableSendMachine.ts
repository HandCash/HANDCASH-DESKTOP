/**
 * Parent statechart for collectable transfer routing.
 *
 * Classifies once into an exhaustive `SendPath`, then invokes hardened or
 * soft-latch. There is no edge from hardened → softLatch — covenant tips that
 * cannot harden refuse instead of falling through.
 *
 * UI confirm flow (edit → confirm) stays in the panel machine; this chart owns
 * the on-chain path only.
 */
import { assign, setup, type SnapshotFrom } from 'xstate'
import type { SendPath } from './collectableTipKind'

export type CollectableSendPhase =
  | 'idle'
  | 'classifying'
  | 'hardened'
  | 'softLatch'
  | 'refusing'
  | 'done'
  | 'failed'

export type CollectableSendContext = {
  outpoint: string
  sendPath: SendPath | null
  txid: string | null
  error: string | null
}

export type CollectableSendEvent =
  | { type: 'START'; outpoint: string; sendPath: SendPath }
  | { type: 'PATH_HARDENED' }
  | { type: 'PATH_SOFT_LATCH' }
  | { type: 'PATH_REFUSE'; reason: string }
  | { type: 'SUCCESS'; txid: string }
  | { type: 'FAIL'; error: string }
  | { type: 'RESET' }

function pathKind(
  path: SendPath | null,
): 'hardened' | 'softLatch' | 'refuse' | null {
  if (!path) return null
  if (path.path === 'refuse') return 'refuse'
  if (path.path === 'softLatch') return 'softLatch'
  return 'hardened'
}

export const collectableSendMachine = setup({
  types: {
    context: {} as CollectableSendContext,
    events: {} as CollectableSendEvent,
  },
  guards: {
    choseHardened: ({ context }) => pathKind(context.sendPath) === 'hardened',
    choseSoftLatch: ({ context }) => pathKind(context.sendPath) === 'softLatch',
    choseRefuse: ({ context }) => pathKind(context.sendPath) === 'refuse',
  },
  actions: {
    begin: assign(({ event }) => {
      if (event.type !== 'START') return {}
      return {
        outpoint: event.outpoint,
        sendPath: event.sendPath,
        txid: null,
        error: null,
      }
    }),
    setTxid: assign(({ event }) =>
      event.type === 'SUCCESS' ? { txid: event.txid, error: null } : {},
    ),
    setError: assign(({ event }) => {
      if (event.type === 'FAIL') return { error: event.error }
      if (event.type === 'PATH_REFUSE') return { error: event.reason }
      return {}
    }),
    clear: assign({
      outpoint: '',
      sendPath: null,
      txid: null,
      error: null,
    }),
  },
}).createMachine({
  id: 'collectableSend',
  initial: 'idle',
  context: {
    outpoint: '',
    sendPath: null,
    txid: null,
    error: null,
  },
  states: {
    idle: {
      on: {
        START: { target: 'classifying', actions: 'begin' },
      },
    },
    classifying: {
      always: [
        { guard: 'choseRefuse', target: 'refusing' },
        { guard: 'choseHardened', target: 'hardened' },
        { guard: 'choseSoftLatch', target: 'softLatch' },
        {
          target: 'failed',
          actions: assign({ error: 'Send path was not classified' }),
        },
      ],
    },
    hardened: {
      on: {
        SUCCESS: { target: 'done', actions: 'setTxid' },
        FAIL: { target: 'failed', actions: 'setError' },
        // Intentionally no softLatch transition — covenant cannot fall through.
      },
    },
    softLatch: {
      on: {
        SUCCESS: { target: 'done', actions: 'setTxid' },
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    refusing: {
      entry: assign(({ context }) => ({
        error:
          context.sendPath?.path === 'refuse'
            ? context.sendPath.reason
            : context.error,
      })),
      always: { target: 'failed' },
    },
    done: {
      on: { RESET: { target: 'idle', actions: 'clear' } },
    },
    failed: {
      on: { RESET: { target: 'idle', actions: 'clear' } },
    },
  },
})

export type CollectableSendSnapshot = SnapshotFrom<typeof collectableSendMachine>

/** Events accepted while in the hardened state — softLatch must not appear. */
export function hardenedStateEventTypes(): readonly string[] {
  const node = collectableSendMachine.states.hardened
  return Object.keys(node?.on ?? {})
}
