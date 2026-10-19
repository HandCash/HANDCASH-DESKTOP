import { assign, setup } from 'xstate'

type Context = {
  operation: 'receive' | 'prove' | 'send' | null
  txid: string | null
  error: string | null
}

type Event =
  | { type: 'RECEIVE' }
  | { type: 'PROVE' }
  | { type: 'SEND' }
  | { type: 'RESUME_BROADCAST'; txid: string }
  | { type: 'SEEN' }
  | { type: 'REFUSED'; error: string }
  | { type: 'PENDING' }
  | { type: 'PROVEN' }
  | { type: 'VOIDED' }
  | { type: 'SIGNED'; txid: string }
  | { type: 'BROADCASTED' }
  | { type: 'BROADCAST_QUEUED'; error: string }
  | { type: 'FAIL'; error: string }

/**
 * A native coin on a UTXO chain (BRC-213: Litecoin, Bitcoin Cash, Bitcoin, Dogecoin): the wallet
 * holds its own key on that chain and nothing is wrapped, minted or burned,
 * so no one ever holds a claim on anyone else. One chart for every chain.
 *
 * Receive: an output paying the wallet's address is SEEN once its raw
 * transaction hashes to its txid and pays this wallet's script; anything else
 * is REFUSED.
 *
 * Prove: a received coin stays PENDING while this wallet's own header chain for
 * the coin counts fewer than 6 confirmations over its block; then its burial
 * proof is kept and it can be spent. A coin the explorers stop knowing is
 * VOIDED (abandoned): presentation only, it is never spent.
 *
 * Send: the payment is SIGNED and recorded before it is broadcast; a failed
 * broadcast is QUEUED and retried until it confirms. A signed payment is never
 * re-signed with other coins.
 */
export const coinMachine = setup({
  types: { context: {} as Context, events: {} as Event },
  actions: {
    receive: assign({ operation: 'receive', txid: null, error: null }),
    prove: assign({ operation: 'prove', txid: null, error: null }),
    send: assign({ operation: 'send', txid: null, error: null }),
    resume: assign(({ event }) => (event.type === 'RESUME_BROADCAST' ? { operation: 'send' as const, txid: event.txid, error: null } : {})),
    txid: assign(({ event }) => (event.type === 'SIGNED' ? { txid: event.txid } : {})),
    error: assign(({ event }) =>
      event.type === 'FAIL' || event.type === 'REFUSED' || event.type === 'BROADCAST_QUEUED' ? { error: event.error } : {},
    ),
  },
}).createMachine({
  id: 'coin',
  initial: 'idle',
  context: { operation: null, txid: null, error: null },
  states: {
    idle: {
      on: {
        RECEIVE: { target: 'reading', actions: 'receive' },
        PROVE: { target: 'proving', actions: 'prove' },
        SEND: { target: 'building', actions: 'send' },
        RESUME_BROADCAST: { target: 'broadcasting', actions: 'resume' },
      },
    },
    reading: {
      on: {
        SEEN: 'received',
        REFUSED: { target: 'refused', actions: 'error' },
        FAIL: { target: 'failed', actions: 'error' },
      },
    },
    proving: {
      on: {
        PROVEN: 'proven',
        PENDING: 'pending',
        VOIDED: 'voided',
        FAIL: { target: 'failed', actions: 'error' },
      },
    },
    building: {
      on: {
        SIGNED: { target: 'broadcasting', actions: 'txid' },
        FAIL: { target: 'failed', actions: 'error' },
      },
    },
    // Signed is final against the coins it spends: this payment must land.
    broadcasting: {
      on: {
        BROADCASTED: 'sent',
        BROADCAST_QUEUED: { target: 'queued', actions: 'error' },
      },
    },
    received: { type: 'final' },
    refused: { type: 'final' },
    pending: { type: 'final' },
    proven: { type: 'final' },
    voided: { type: 'final' },
    sent: { type: 'final' },
    queued: { type: 'final' },
    failed: { type: 'final' },
  },
})
