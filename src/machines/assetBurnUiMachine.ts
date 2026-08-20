import { assign, setup, type SnapshotFrom } from 'xstate'

/**
 * Chart: assetBurn
 * States: closed → editing → confirming → handoff | failure
 *
 * Same shape as `sendMachine`, because a burn is a spend the user composes and
 * confirms: it owns a side panel (`BurnAssetPanel`), the amount is chosen in
 * `editing` and can no longer be edited in `confirming`, so the irreversible
 * step restates one fixed amount instead of offering a text field beside a
 * destroy button.
 *
 * `CONFIRM` hands the burn to the wallet and leaves the panel — progress and
 * the settled row live in Activity, which outlives this chart. `failure` is a
 * refusal the user can edit their way out of.
 */
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
  | { type: 'REVIEW' }
  | { type: 'BACK' }
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
    fail: assign(({ event }) => (event.type === 'FAIL' ? { error: event.error } : {})),
  },
}).createMachine({
  id: 'assetBurn',
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
      on: { OPEN: { target: 'editing', actions: 'open' } },
    },
    /** Choose what to destroy and read the economics before committing. */
    editing: {
      on: {
        CANCEL: { target: 'closed' },
        SET_AMOUNT: { actions: 'setAmount' },
        PREVIEW: { actions: 'setPreview' },
        REVIEW: { target: 'confirming' },
        FAIL: { target: 'failure', actions: 'fail' },
      },
    },
    /** The amount is fixed here; the only ways out are Back or Burn. */
    confirming: {
      on: {
        BACK: { target: 'editing' },
        CANCEL: { target: 'closed' },
        PREVIEW: { actions: 'setPreview' },
        CONFIRM: { target: 'burning' },
        FAIL: { target: 'failure', actions: 'fail' },
      },
    },
    /** Handed to the wallet. The panel closes; Activity carries the result. */
    burning: {
      on: {
        SUCCESS: { target: 'done', actions: 'succeed' },
        FAIL: { target: 'failure', actions: 'fail' },
      },
    },
    failure: {
      on: {
        BACK: { target: 'editing', actions: 'clearError' },
        SET_AMOUNT: { actions: 'setAmount' },
        PREVIEW: { actions: 'setPreview' },
        CANCEL: { target: 'closed' },
        RESET: { target: 'closed' },
      },
    },
    done: {
      on: { RESET: { target: 'closed' } },
    },
  },
})

export type AssetBurnUiSnapshot = SnapshotFrom<typeof assetBurnUiMachine>
