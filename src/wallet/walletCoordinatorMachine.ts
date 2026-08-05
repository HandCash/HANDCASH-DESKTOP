import { assign, setup } from 'xstate'

/**
 * Wallet layer coordinator — prevents impossible overlaps between UTXO mutation paths.
 * See `layers.ts` + `walletCoordinator.ts`.
 *
 * Parallel regions (all idle when depth === 0):
 * - chainIngest — Refresh / legacy import / 1sat import
 * - spend — send, BRC createAction, collectable transfer
 * - historyReplica — BRC-39 push/pull/restore
 * - recompose — unlock restore (history then chain)
 *
 * Illegal (guarded):
 * - chainIngest × spend (except spend-owned nested heal)
 * - any layer × active recompose (except recompose-internal calls)
 * - historyReplica × chainIngest or spend
 */
export type WalletCoordinatorContext = {
  chainIngestDepth: number
  spendDepth: number
  historyReplicaDepth: number
  recomposeDepth: number
}

export type WalletCoordinatorRegion = 'chainIngest' | 'spend' | 'historyReplica' | 'recompose'

export type WalletCoordinatorSnapshot = Record<WalletCoordinatorRegion, 'idle' | 'active'>

export const initialWalletCoordinatorContext: WalletCoordinatorContext = {
  chainIngestDepth: 0,
  spendDepth: 0,
  historyReplicaDepth: 0,
  recomposeDepth: 0,
}

export function snapshotFromContext(
  context: WalletCoordinatorContext,
): WalletCoordinatorSnapshot {
  return {
    chainIngest: context.chainIngestDepth > 0 ? 'active' : 'idle',
    spend: context.spendDepth > 0 ? 'active' : 'idle',
    historyReplica: context.historyReplicaDepth > 0 ? 'active' : 'idle',
    recompose: context.recomposeDepth > 0 ? 'active' : 'idle',
  }
}

export function canBeginChainIngest(
  context: WalletCoordinatorContext,
  nested: boolean,
): boolean {
  if (context.recomposeDepth > 0) return false
  if (nested) {
    return context.spendDepth > 0 && context.chainIngestDepth === 0
  }
  return (
    context.chainIngestDepth === 0 &&
    context.spendDepth === 0 &&
    context.historyReplicaDepth === 0
  )
}

export function canBeginSpend(context: WalletCoordinatorContext): boolean {
  return (
    context.recomposeDepth === 0 &&
    context.chainIngestDepth === 0 &&
    context.spendDepth === 0 &&
    context.historyReplicaDepth === 0
  )
}

export function canBeginHistoryReplica(context: WalletCoordinatorContext): boolean {
  return (
    context.recomposeDepth === 0 &&
    context.chainIngestDepth === 0 &&
    context.spendDepth === 0 &&
    context.historyReplicaDepth === 0
  )
}

export function canBeginRecompose(context: WalletCoordinatorContext): boolean {
  return (
    context.recomposeDepth === 0 &&
    context.chainIngestDepth === 0 &&
    context.spendDepth === 0 &&
    context.historyReplicaDepth === 0
  )
}

export type WalletCoordinatorEvent =
  | { type: 'CHAIN_INGEST_BEGIN'; nested?: boolean }
  | { type: 'CHAIN_INGEST_END' }
  | { type: 'SPEND_BEGIN' }
  | { type: 'SPEND_END' }
  | { type: 'HISTORY_BEGIN' }
  | { type: 'HISTORY_END' }
  | { type: 'RECOMPOSE_BEGIN' }
  | { type: 'RECOMPOSE_END' }

export const walletCoordinatorMachine = setup({
  types: {
    context: {} as WalletCoordinatorContext,
    events: {} as WalletCoordinatorEvent,
  },
  guards: {
    chainIngestAllowed: ({ context, event }) =>
      event.type === 'CHAIN_INGEST_BEGIN' && canBeginChainIngest(context, Boolean(event.nested)),
    spendAllowed: ({ context, event }) =>
      event.type === 'SPEND_BEGIN' && canBeginSpend(context),
    historyAllowed: ({ context, event }) =>
      event.type === 'HISTORY_BEGIN' && canBeginHistoryReplica(context),
    recomposeAllowed: ({ context, event }) =>
      event.type === 'RECOMPOSE_BEGIN' && canBeginRecompose(context),
  },
  actions: {
    incChainIngest: assign({
      chainIngestDepth: ({ context }) => context.chainIngestDepth + 1,
    }),
    decChainIngest: assign({
      chainIngestDepth: ({ context }) => Math.max(0, context.chainIngestDepth - 1),
    }),
    incSpend: assign({
      spendDepth: ({ context }) => context.spendDepth + 1,
    }),
    decSpend: assign({
      spendDepth: ({ context }) => Math.max(0, context.spendDepth - 1),
    }),
    incHistory: assign({
      historyReplicaDepth: ({ context }) => context.historyReplicaDepth + 1,
    }),
    decHistory: assign({
      historyReplicaDepth: ({ context }) => Math.max(0, context.historyReplicaDepth - 1),
    }),
    incRecompose: assign({
      recomposeDepth: ({ context }) => context.recomposeDepth + 1,
    }),
    decRecompose: assign({
      recomposeDepth: ({ context }) => Math.max(0, context.recomposeDepth - 1),
    }),
  },
}).createMachine({
  id: 'walletCoordinator',
  context: initialWalletCoordinatorContext,
  on: {
    CHAIN_INGEST_BEGIN: {
      guard: 'chainIngestAllowed',
      actions: 'incChainIngest',
    },
    CHAIN_INGEST_END: { actions: 'decChainIngest' },
    SPEND_BEGIN: {
      guard: 'spendAllowed',
      actions: 'incSpend',
    },
    SPEND_END: { actions: 'decSpend' },
    HISTORY_BEGIN: {
      guard: 'historyAllowed',
      actions: 'incHistory',
    },
    HISTORY_END: { actions: 'decHistory' },
    RECOMPOSE_BEGIN: {
      guard: 'recomposeAllowed',
      actions: 'incRecompose',
    },
    RECOMPOSE_END: { actions: 'decRecompose' },
  },
})
