/**
 * XState chart for the dual-layer tx confirmation lifecycle.
 *
 * Send-path machines (bsv / soft-latch / BRC-29) still own *who* broadcasts.
 * This chart owns DRAFT → … → MINED / FAILED / REORG after dispatch starts.
 */
import { assign, setup } from 'xstate'
import type { ArcStatus, TxDiagnosticCode, TxStatus } from './txLifecycle'

export type TxLifecycleContext = {
  id: string
  txid: string | null
  status: TxStatus
  arcStatus: ArcStatus | null
  diagnostic: TxDiagnosticCode | null
  minedHeight: number | null
  error: string | null
}

export type TxLifecycleEvent =
  | { type: 'START'; id: string }
  | { type: 'VALIDATED' }
  | { type: 'VALIDATE_FAIL'; code: TxDiagnosticCode; detail?: string }
  | { type: 'DISPATCH' }
  | { type: 'TXID'; txid: string }
  | { type: 'ARC'; status: ArcStatus }
  | { type: 'MEMPOOL' }
  | { type: 'BUMP_VERIFIED'; height: number }
  | { type: 'BUMP_FAIL'; detail?: string }
  | { type: 'REJECT'; code: TxDiagnosticCode; detail?: string }
  | { type: 'REORG' }
  | { type: 'REANNOUNCED' }
  | { type: 'RESET' }

export const txLifecycleMachine = setup({
  types: {
    context: {} as TxLifecycleContext,
    events: {} as TxLifecycleEvent,
  },
  actions: {
    begin: assign(({ event }) =>
      event.type === 'START'
        ? {
            id: event.id,
            txid: null,
            status: 'DRAFT' as const,
            arcStatus: null,
            diagnostic: null,
            minedHeight: null,
            error: null,
          }
        : {},
    ),
    toValidating: assign({ status: 'VALIDATING' as const }),
    toBroadcasting: assign({ status: 'BROADCASTING' as const }),
    toMempool: assign({
      status: 'SEEN_IN_MEMPOOL' as const,
      diagnostic: null,
      error: null,
    }),
    toMined: assign(({ event }) =>
      event.type === 'BUMP_VERIFIED'
        ? {
            status: 'MINED' as const,
            minedHeight: event.height,
            arcStatus: 'MINED' as const,
            diagnostic: null,
            error: null,
          }
        : {},
    ),
    toFailed: assign(({ event, context }) => {
      if (event.type === 'VALIDATE_FAIL' || event.type === 'REJECT') {
        return {
          status: 'FAILED_REJECTED' as const,
          diagnostic: event.code,
          error: event.detail ?? event.code,
        }
      }
      if (event.type === 'ARC') {
        const code =
          event.status === 'DOUBLE_SPEND_ATTEMPTED'
            ? ('ARC_DOUBLE_SPEND' as const)
            : ('ARC_REJECTED' as const)
        return {
          status: 'FAILED_REJECTED' as const,
          diagnostic: code,
          error: code,
          arcStatus: event.status,
        }
      }
      if (event.type === 'BUMP_FAIL') {
        return {
          status: 'SEEN_IN_MEMPOOL' as const,
          diagnostic: 'BUMP_UNVERIFIED' as const,
          error: event.detail ?? 'BUMP_UNVERIFIED',
        }
      }
      return { status: context.status }
    }),
    toOrphaned: assign({
      status: 'REORG_ORPHANED' as const,
      minedHeight: null,
      diagnostic: 'REORG' as const,
      error: 'Block reorg orphaned this transaction',
    }),
    setTxid: assign(({ event }) =>
      event.type === 'TXID' ? { txid: event.txid.toLowerCase() } : {},
    ),
    setArc: assign(({ event }) =>
      event.type === 'ARC' ? { arcStatus: event.status } : {},
    ),
    clear: assign({
      id: '',
      txid: null,
      status: 'DRAFT' as const,
      arcStatus: null,
      diagnostic: null,
      minedHeight: null,
      error: null,
    }),
  },
  guards: {
    arcReject: ({ event }) =>
      event.type === 'ARC' &&
      (event.status === 'REJECTED' || event.status === 'DOUBLE_SPEND_ATTEMPTED'),
    arcSeen: ({ event }) =>
      event.type === 'ARC' &&
      (event.status === 'SEEN_ON_NETWORK' ||
        event.status === 'STORED' ||
        event.status === 'ANNOUNCED_TO_NETWORK' ||
        event.status === 'MINED'),
  },
}).createMachine({
  id: 'txLifecycle',
  initial: 'idle',
  context: {
    id: '',
    txid: null,
    status: 'DRAFT',
    arcStatus: null,
    diagnostic: null,
    minedHeight: null,
    error: null,
  },
  states: {
    idle: {
      on: { START: { target: 'draft', actions: 'begin' } },
    },
    draft: {
      on: {
        VALIDATED: { target: 'validating', actions: 'toValidating' },
        VALIDATE_FAIL: { target: 'failed', actions: 'toFailed' },
      },
    },
    validating: {
      on: {
        DISPATCH: { target: 'broadcasting', actions: 'toBroadcasting' },
        VALIDATE_FAIL: { target: 'failed', actions: 'toFailed' },
      },
    },
    broadcasting: {
      on: {
        TXID: { actions: 'setTxid' },
        MEMPOOL: { target: 'seenInMempool', actions: 'toMempool' },
        ARC: [
          {
            guard: 'arcReject',
            target: 'failed',
            actions: ['setArc', 'toFailed'],
          },
          {
            guard: 'arcSeen',
            target: 'seenInMempool',
            actions: ['setArc', 'toMempool'],
          },
        ],
        REJECT: { target: 'failed', actions: 'toFailed' },
      },
    },
    seenInMempool: {
      on: {
        BUMP_VERIFIED: { target: 'mined', actions: 'toMined' },
        BUMP_FAIL: { actions: 'toFailed' },
        ARC: [
          {
            guard: 'arcReject',
            target: 'failed',
            actions: ['setArc', 'toFailed'],
          },
          { actions: 'setArc' },
        ],
        REJECT: { target: 'failed', actions: 'toFailed' },
        REORG: { target: 'reorgOrphaned', actions: 'toOrphaned' },
      },
    },
    mined: {
      on: {
        REORG: { target: 'reorgOrphaned', actions: 'toOrphaned' },
        RESET: { target: 'idle', actions: 'clear' },
      },
    },
    reorgOrphaned: {
      on: {
        REANNOUNCED: { target: 'seenInMempool', actions: 'toMempool' },
        REJECT: { target: 'failed', actions: 'toFailed' },
        MEMPOOL: { target: 'seenInMempool', actions: 'toMempool' },
      },
    },
    failed: {
      on: { RESET: { target: 'idle', actions: 'clear' } },
    },
  },
})
