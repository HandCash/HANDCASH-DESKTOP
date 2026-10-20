import { assign, setup } from 'xstate'

type Context = {
  operation: 'issue' | 'mint' | 'transfer' | 'burn' | null
  txid: string | null
  error: string | null
}

type Event =
  | { type: 'ISSUE' }
  | { type: 'MINT' }
  | { type: 'TRANSFER' }
  | { type: 'BURN' }
  | { type: 'BUILT' }
  | { type: 'SIGNED'; txid: string }
  | { type: 'BROADCASTED' }
  | { type: 'DELIVERED' }
  | { type: 'QUEUED' }
  | { type: 'FAIL'; error: string }

/**
 * Issue, mint, transfer or burn an open BRC-255 asset. Nothing exists until SIGNED; a
 * failure before it aborts the action and the holder's outputs stay put.
 * After SIGNED the transaction is the payment: miner propagation is the
 * signed-send lifecycle's, and a failed delivery only queues the package in
 * the outbox (QUEUED), it never voids the transfer.
 */
export const bntMachine = setup({
  types: { context: {} as Context, events: {} as Event },
  actions: {
    issue: assign({ operation: 'issue', txid: null, error: null }),
    mint: assign({ operation: 'mint', txid: null, error: null }),
    transfer: assign({ operation: 'transfer', txid: null, error: null }),
    burn: assign({ operation: 'burn', txid: null, error: null }),
    txid: assign(({ event }) => (event.type === 'SIGNED' ? { txid: event.txid } : {})),
    error: assign(({ event }) => (event.type === 'FAIL' ? { error: event.error } : {})),
  },
}).createMachine({
  id: 'bnt',
  initial: 'idle',
  context: { operation: null, txid: null, error: null },
  states: {
    idle: {
      on: {
        ISSUE: { target: 'building', actions: 'issue' },
        MINT: { target: 'building', actions: 'mint' },
        TRANSFER: { target: 'building', actions: 'transfer' },
        BURN: { target: 'building', actions: 'burn' },
      },
    },
    building: {
      on: {
        BUILT: 'signing',
        FAIL: { target: 'failed', actions: 'error' },
      },
    },
    signing: {
      on: {
        SIGNED: { target: 'signed', actions: 'txid' },
        FAIL: { target: 'failed', actions: 'error' },
      },
    },
    // Signed is final against the sender: a later failure never voids it.
    signed: {
      on: {
        BROADCASTED: 'delivering',
        FAIL: { actions: 'error' },
      },
    },
    delivering: {
      on: {
        DELIVERED: 'committed',
        QUEUED: 'committed',
        FAIL: { actions: 'error' },
      },
    },
    committed: { type: 'final' },
    failed: { type: 'final' },
  },
})
