/**
 * Parent statechart for BSV-21 fungible transfer routing.
 *
 * Classifies once into an exhaustive {@link Bsv21SendPath}, then invokes the
 * plain P2PKH item-settle path or refuses. Cosigned tips have no silent
 * fallthrough — they refuse until a cosigner client is configured.
 */
import { assign, setup, type SnapshotFrom } from 'xstate'
import type { Bsv21SendPath } from './bsv21TipKind'

export type Bsv21SendPhase =
  | 'idle'
  | 'classifying'
  | 'plainSend'
  | 'refusing'
  | 'done'
  | 'failed'

export type Bsv21SendContext = {
  tokenId: string
  sendPath: Bsv21SendPath | null
  txid: string | null
  error: string | null
}

export type Bsv21SendEvent =
  | { type: 'START'; tokenId: string; sendPath: Bsv21SendPath }
  | { type: 'PATH_PLAIN_SEND' }
  | { type: 'PATH_REFUSE'; reason: string }
  | { type: 'SUCCESS'; txid: string }
  | { type: 'FAIL'; error: string }
  | { type: 'RESET' }

function pathKind(path: Bsv21SendPath | null): 'plainSend' | 'refuse' | null {
  if (!path) return null
  if (path.path === 'refuse') return 'refuse'
  if (path.path === 'plain') return 'plainSend'
  // Cosigned with a client available is still a refuse for wallet-native send
  // until a cosigner client is wired — chooseBsv21SendPath only returns
  // cosigned when cosignerAvailable is true.
  if (path.path === 'cosigned') return 'refuse'
  return null
}

export const bsv21SendMachine = setup({
  types: {
    context: {} as Bsv21SendContext,
    events: {} as Bsv21SendEvent,
  },
  guards: {
    chosePlainSend: ({ context }) => pathKind(context.sendPath) === 'plainSend',
    choseRefuse: ({ context }) => pathKind(context.sendPath) === 'refuse',
  },
  actions: {
    begin: assign(({ event }) => {
      if (event.type !== 'START') return {}
      return {
        tokenId: event.tokenId,
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
      tokenId: '',
      sendPath: null,
      txid: null,
      error: null,
    }),
  },
}).createMachine({
  id: 'bsv21Send',
  initial: 'idle',
  context: {
    tokenId: '',
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
        { guard: 'chosePlainSend', target: 'plainSend' },
        {
          target: 'failed',
          actions: assign({ error: 'Send path was not classified' }),
        },
      ],
    },
    plainSend: {
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
            : context.sendPath?.path === 'cosigned'
              ? 'cosigner_required'
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

export type Bsv21SendSnapshot = SnapshotFrom<typeof bsv21SendMachine>
