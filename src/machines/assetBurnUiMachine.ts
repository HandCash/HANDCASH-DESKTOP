import { assign, setup, type SnapshotFrom } from 'xstate'

export type AssetBurnUiEvent =
  | { type: 'OPEN'; amount?: string }
  | { type: 'SET_AMOUNT'; amount: string }
  | {
      type: 'PREVIEW'
      preview: {
        grossSats: number
        protocolOutputSats: number
        estimatedFeeSats: number
      } | null
    }
  | { type: 'CANCEL' }
  | { type: 'CONFIRM' }
  | { type: 'SUCCESS'; txid: string; recoveredSatoshis: number }
  | { type: 'FAIL'; error: string }
  | { type: 'RESET' }

export type AssetBurnUiContext = {
  error: string | null
  txid: string | null
  recoveredSatoshis: number
  amount: string
  preview: {
    grossSats: number
    protocolOutputSats: number
    estimatedFeeSats: number
  } | null
}

export const assetBurnUiMachine = setup({
  types: {
    context: {} as AssetBurnUiContext,
    events: {} as AssetBurnUiEvent,
  },
  actions: {
    clear: assign({
      error: null,
      txid: null,
      recoveredSatoshis: 0,
      amount: '',
      preview: null,
    }),
    open: assign(({ event }) =>
      event.type === 'OPEN'
        ? { amount: event.amount ?? '', error: null, preview: null }
        : {},
    ),
    setAmount: assign(({ event }) =>
      event.type === 'SET_AMOUNT'
        ? { amount: event.amount, error: null, preview: null }
        : {},
    ),
    clearError: assign({ error: null }),
    setPreview: assign(({ event }) =>
      event.type === 'PREVIEW' ? { preview: event.preview } : {},
    ),
    succeed: assign(({ event }) =>
      event.type === 'SUCCESS'
        ? {
            error: null,
            txid: event.txid,
            recoveredSatoshis: event.recoveredSatoshis,
          }
        : {},
    ),
    fail: assign(({ event }) =>
      event.type === 'FAIL' ? { error: event.error } : {},
    ),
  },
}).createMachine({
  id: 'assetBurnUi',
  initial: 'closed',
  context: {
    error: null,
    txid: null,
    recoveredSatoshis: 0,
    amount: '',
    preview: null,
  },
  states: {
    closed: {
      entry: 'clear',
      on: { OPEN: { target: 'confirming', actions: 'open' } },
    },
    confirming: {
      on: {
        CANCEL: { target: 'closed' },
        SET_AMOUNT: { actions: 'setAmount' },
        PREVIEW: { actions: 'setPreview' },
        CONFIRM: { target: 'burning' },
        FAIL: { target: 'failed', actions: 'fail' },
      },
    },
    burning: {
      on: {
        SUCCESS: { target: 'done', actions: 'succeed' },
        FAIL: { target: 'failed', actions: 'fail' },
      },
    },
    failed: {
      on: {
        CONFIRM: { target: 'burning', actions: 'clearError' },
        SET_AMOUNT: { actions: 'setAmount' },
        PREVIEW: { actions: 'setPreview' },
        CANCEL: { target: 'closed' },
      },
    },
    done: {
      on: { RESET: { target: 'closed' } },
    },
  },
})

export type AssetBurnUiSnapshot = SnapshotFrom<typeof assetBurnUiMachine>
