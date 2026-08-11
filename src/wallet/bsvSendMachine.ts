/**
 * BSV P2PKH payment phases (chain path — not the UI edit/confirm chart).
 *
 * UI `sendMachine` stays for the form; this chart owns local balance check →
 * broadcast → done so pending-send / insufficient-funds / broadcast failure
 * are explicit states. Chain ingest is not a pay prerequisite.
 */
import { assign, setup } from 'xstate'

export type BsvSendContext = {
  to: string
  satoshis: number
  txid: string | null
  error: string | null
}

export type BsvSendEvent =
  | { type: 'START'; to: string; satoshis: number }
  | { type: 'READY' }
  | { type: 'BROADCASTED'; txid: string }
  | { type: 'FAIL'; error: string }
  | { type: 'RESET' }

export const bsvSendMachine = setup({
  types: {
    context: {} as BsvSendContext,
    events: {} as BsvSendEvent,
  },
  actions: {
    begin: assign(({ event }) =>
      event.type === 'START'
        ? {
            to: event.to,
            satoshis: event.satoshis,
            txid: null,
            error: null,
          }
        : {},
    ),
    setTxid: assign(({ event }) =>
      event.type === 'BROADCASTED' ? { txid: event.txid, error: null } : {},
    ),
    setError: assign(({ event }) =>
      event.type === 'FAIL' ? { error: event.error } : {},
    ),
    clear: assign({ to: '', satoshis: 0, txid: null, error: null }),
  },
}).createMachine({
  id: 'bsvSend',
  initial: 'idle',
  context: { to: '', satoshis: 0, txid: null, error: null },
  states: {
    idle: {
      on: { START: { target: 'preparing', actions: 'begin' } },
    },
    preparing: {
      on: {
        READY: 'broadcasting',
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    broadcasting: {
      on: {
        BROADCASTED: { target: 'done', actions: 'setTxid' },
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    done: {
      on: { RESET: { target: 'idle', actions: 'clear' } },
    },
    failed: {
      on: { RESET: { target: 'idle', actions: 'clear' } },
    },
  },
})
