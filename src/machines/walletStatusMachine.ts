import { assign, setup } from 'xstate'
import type { CloudBackupHealth } from '../wallet/cloudBackupHealth'
import type { WalletCoordinatorLiveStatus } from '../wallet/walletCoordinator'
import type { SyncHealth } from '../wallet/walletHealth'
import { isWalletProgressBusy, type WalletProgress } from '../wallet/walletProgress'

export type WalletSession =
  | 'boot'
  | 'onboarding'
  | 'locked'
  | 'ready'
  | 'sending'
  | 'failure'

export type WalletStatusInput = {
  session: WalletSession
  health: SyncHealth
  cloud: CloudBackupHealth
  networkOnline: boolean
  /** Local BRC-100 HTTP bridge is listening. */
  bridgeOnline: boolean
  progress: WalletProgress
  coordinator: WalletCoordinatorLiveStatus
}

export type WalletStatusContext = WalletStatusInput & {
  /** A manual refresh from the pill has not settled yet. */
  refreshing: boolean
}

export type WalletStatusEvent =
  | { type: 'SESSION'; session: WalletSession }
  | { type: 'SYNC_HEALTH'; health: SyncHealth }
  | { type: 'BACKUP_HEALTH'; cloud: CloudBackupHealth }
  | { type: 'NETWORK'; online: boolean }
  | { type: 'BRIDGE'; online: boolean }
  | { type: 'WALLET_PROGRESS'; progress: WalletProgress }
  | { type: 'COORDINATOR'; coordinator: WalletCoordinatorLiveStatus }
  | { type: 'REFRESH' }
  | { type: 'REFRESH_DONE' }

/** Highest priority first; `walletStatusFor` is the single place that ranks them. */
export const WALLET_STATUS_STATES = [
  'opening',
  'failed',
  'offline',
  'refreshing',
  'catchingUp',
  'syncFailed',
  'backupFailed',
  'backupDelayed',
  'waitingToSend',
  'syncing',
  'locked',
  'setup',
  'bridgeOff',
  'itemArriving',
  'networkSlow',
  'synced',
  'ready',
] as const

export type WalletStatusState = (typeof WALLET_STATUS_STATES)[number]

export function isUnlockedSession(session: WalletSession): boolean {
  return session === 'ready' || session === 'sending'
}

function chainBusy(c: WalletStatusInput): boolean {
  return (
    isWalletProgressBusy(c.progress) ||
    c.coordinator.chainIngest === 'active' ||
    c.coordinator.spendWaiting > 0 ||
    c.health.phase === 'syncing'
  )
}

export function walletStatusFor(c: WalletStatusContext): WalletStatusState {
  if (c.session === 'boot') return 'opening'
  if (c.session === 'failure') return 'failed'
  if (!c.networkOnline) return 'offline'
  if (c.refreshing && !chainBusy(c)) return 'refreshing'
  // Progress stays honest after a soft Syncing clear: never Synced while
  // Refresh, 1sat or phrase import is still running.
  if (isWalletProgressBusy(c.progress)) return 'catchingUp'
  if (c.health.phase === 'error') return 'syncFailed'
  if (c.cloud.phase === 'error') return 'backupFailed'
  if (c.cloud.phase === 'delayed') return 'backupDelayed'
  // The coordinator is ground truth for the spend lock; the syncing watchdog
  // can report ok while chain ingest is still active.
  if (c.coordinator.spendWaiting > 0) return 'waitingToSend'
  if (c.coordinator.chainIngest === 'active') return 'catchingUp'
  if (c.health.phase === 'syncing') return 'syncing'
  if (c.session === 'locked') return 'locked'
  if (c.session === 'onboarding') return 'setup'
  if (!c.bridgeOnline) return 'bridgeOff'
  // A latch-proven tip not yet named is an item that has landed; Synced while
  // it is missing from Collectables makes a transfer look lost.
  if (c.health.pendingTips > 0) return 'itemArriving'
  if (c.health.phase === 'ok') {
    if (c.health.reason === 'timeout') return 'networkSlow'
    if (c.health.reason === 'stillImporting') return 'catchingUp'
    return 'synced'
  }
  return c.cloud.phase === 'ok' ? 'synced' : 'ready'
}

/** The pill is disabled while a refresh, sync, import or spend is under way. */
export function refreshBlocked(c: WalletStatusContext): boolean {
  return c.refreshing || chainBusy(c) || c.coordinator.spend === 'active'
}

function canRefresh(c: WalletStatusContext): boolean {
  return isUnlockedSession(c.session) && c.networkOnline && !refreshBlocked(c)
}

const evaluate = { target: '.evaluate' } as const

/**
 * Top-bar wallet status. The stores feed typed events; the chart ranks them
 * into one state. Send progress is not here: it lives on the send's Activity row.
 */
export const walletStatusMachine = setup({
  types: {
    context: {} as WalletStatusContext,
    input: {} as WalletStatusInput,
    events: {} as WalletStatusEvent,
  },
  guards: {
    canRefresh: ({ context }) => canRefresh(context),
    is: ({ context }, params: { state: WalletStatusState }) =>
      walletStatusFor(context) === params.state,
  },
}).createMachine({
  id: 'walletStatus',
  context: ({ input }) => ({ ...input, refreshing: false }),
  initial: 'evaluate',
  on: {
    SESSION: { ...evaluate, actions: assign({ session: ({ event }) => event.session }) },
    SYNC_HEALTH: { ...evaluate, actions: assign({ health: ({ event }) => event.health }) },
    BACKUP_HEALTH: { ...evaluate, actions: assign({ cloud: ({ event }) => event.cloud }) },
    NETWORK: { ...evaluate, actions: assign({ networkOnline: ({ event }) => event.online }) },
    BRIDGE: { ...evaluate, actions: assign({ bridgeOnline: ({ event }) => event.online }) },
    WALLET_PROGRESS: {
      ...evaluate,
      actions: assign({ progress: ({ event }) => event.progress }),
    },
    COORDINATOR: {
      ...evaluate,
      actions: assign({ coordinator: ({ event }) => event.coordinator }),
    },
    REFRESH: { ...evaluate, guard: 'canRefresh', actions: assign({ refreshing: true }) },
    REFRESH_DONE: { ...evaluate, actions: assign({ refreshing: false }) },
  },
  states: {
    evaluate: {
      always: WALLET_STATUS_STATES.map((state) => ({
        guard: { type: 'is' as const, params: { state } },
        target: state,
      })),
    },
    opening: {},
    failed: {},
    offline: {},
    refreshing: {},
    catchingUp: {},
    syncFailed: {},
    backupFailed: {},
    backupDelayed: {},
    waitingToSend: {},
    syncing: {},
    locked: {},
    setup: {},
    bridgeOff: {},
    itemArriving: {},
    networkSlow: {},
    synced: {},
    ready: {},
  },
})
