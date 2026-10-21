import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import type { CloudBackupHealth } from '../wallet/cloudBackupHealth'
import type { WalletCoordinatorLiveStatus } from '../wallet/walletCoordinator'
import type { SyncHealth } from '../wallet/walletHealth'
import type { WalletProgress } from '../wallet/walletProgress'
import {
  WALLET_STATUS_STATES,
  walletStatusMachine,
  type WalletStatusInput,
} from './walletStatusMachine'

const health = (patch: Partial<SyncHealth> = {}): SyncHealth => ({
  phase: 'ok',
  reason: null,
  message: null,
  heldOneSats: 0,
  pendingTips: 0,
  updatedAt: 0,
  identityKey: null,
  accountIndex: null,
  ...patch,
})

const cloudOff: CloudBackupHealth = { phase: 'off', label: 'Off', message: null, checkedAt: 0 }

const progressIdle: WalletProgress = {
  kind: null,
  phase: null,
  current: null,
  total: null,
  failed: 0,
  skipped: 0,
  status: 'idle',
  message: null,
  updatedAt: 0,
}

const coordinatorIdle: WalletCoordinatorLiveStatus = {
  chainIngest: 'idle',
  spend: 'idle',
  historyReplica: 'idle',
  recompose: 'idle',
  spendWaiting: 0,
  summary: 'idle',
}

function start(patch: Partial<WalletStatusInput> = {}) {
  const input: WalletStatusInput = {
    session: 'ready',
    health: health(),
    cloud: cloudOff,
    networkOnline: true,
    bridgeOnline: true,
    progress: progressIdle,
    coordinator: coordinatorIdle,
    ...patch,
  }
  return createActor(walletStatusMachine, { input }).start()
}

describe('walletStatusMachine', () => {
  it('declares every top-bar state the pill can show', () => {
    expect(Object.keys(walletStatusMachine.config.states ?? {})).toEqual([
      'evaluate',
      ...WALLET_STATUS_STATES,
    ])
  })

  it('opens on the ranked state for its input', () => {
    expect(start().getSnapshot().value).toBe('synced')
    expect(start({ session: 'boot' }).getSnapshot().value).toBe('opening')
    expect(start({ session: 'locked', health: health({ phase: 'idle' }) }).getSnapshot().value).toBe(
      'locked',
    )
    expect(start({ health: health({ phase: 'idle' }) }).getSnapshot().value).toBe('ready')
  })

  it('follows each store event', () => {
    const actor = start()
    actor.send({ type: 'SYNC_HEALTH', health: health({ phase: 'syncing' }) })
    expect(actor.getSnapshot().value).toBe('syncing')
    actor.send({ type: 'SYNC_HEALTH', health: health({ phase: 'error' }) })
    expect(actor.getSnapshot().value).toBe('syncFailed')
    actor.send({ type: 'SYNC_HEALTH', health: health() })
    actor.send({ type: 'BACKUP_HEALTH', cloud: { ...cloudOff, phase: 'error' } })
    expect(actor.getSnapshot().value).toBe('backupFailed')
    actor.send({ type: 'BACKUP_HEALTH', cloud: { ...cloudOff, phase: 'delayed' } })
    expect(actor.getSnapshot().value).toBe('backupDelayed')
    actor.send({ type: 'BACKUP_HEALTH', cloud: cloudOff })
    actor.send({ type: 'COORDINATOR', coordinator: { ...coordinatorIdle, spendWaiting: 1 } })
    expect(actor.getSnapshot().value).toBe('waitingToSend')
    actor.send({ type: 'COORDINATOR', coordinator: { ...coordinatorIdle, chainIngest: 'active' } })
    expect(actor.getSnapshot().value).toBe('catchingUp')
    actor.send({ type: 'COORDINATOR', coordinator: coordinatorIdle })
    actor.send({ type: 'WALLET_PROGRESS', progress: { ...progressIdle, status: 'running' } })
    expect(actor.getSnapshot().value).toBe('catchingUp')
    actor.send({ type: 'WALLET_PROGRESS', progress: progressIdle })
    actor.send({ type: 'BRIDGE', online: false })
    expect(actor.getSnapshot().value).toBe('bridgeOff')
    actor.send({ type: 'BRIDGE', online: true })
    actor.send({ type: 'NETWORK', online: false })
    expect(actor.getSnapshot().value).toBe('offline')
    actor.send({ type: 'NETWORK', online: true })
    actor.send({ type: 'SESSION', session: 'failure' })
    expect(actor.getSnapshot().value).toBe('failed')
    actor.send({ type: 'SESSION', session: 'onboarding' })
    expect(actor.getSnapshot().value).toBe('setup')
    actor.send({ type: 'SESSION', session: 'ready' })
    expect(actor.getSnapshot().value).toBe('synced')
  })

  it('reads the sync reason, not the message text', () => {
    const actor = start()
    actor.send({ type: 'SYNC_HEALTH', health: health({ reason: 'timeout' }) })
    expect(actor.getSnapshot().value).toBe('networkSlow')
    actor.send({ type: 'SYNC_HEALTH', health: health({ reason: 'stillImporting' }) })
    expect(actor.getSnapshot().value).toBe('catchingUp')
    actor.send({
      type: 'SYNC_HEALTH',
      health: health({ message: 'Refresh took too long — still importing' }),
    })
    expect(actor.getSnapshot().value).toBe('synced')
  })

  it('shows an item arriving instead of Synced while a tip is unnamed', () => {
    const actor = start({ health: health({ pendingTips: 2 }) })
    expect(actor.getSnapshot().value).toBe('itemArriving')
  })

  it('runs a manual refresh as its own state until it settles', () => {
    const actor = start({ health: health({ phase: 'error' }) })
    expect(actor.getSnapshot().can({ type: 'REFRESH' })).toBe(true)
    actor.send({ type: 'REFRESH' })
    expect(actor.getSnapshot().value).toBe('refreshing')
    expect(actor.getSnapshot().can({ type: 'REFRESH' })).toBe(false)

    actor.send({ type: 'SYNC_HEALTH', health: health({ phase: 'syncing' }) })
    expect(actor.getSnapshot().value).toBe('syncing')
    actor.send({ type: 'SYNC_HEALTH', health: health() })
    expect(actor.getSnapshot().value).toBe('refreshing')

    actor.send({ type: 'REFRESH_DONE' })
    expect(actor.getSnapshot().value).toBe('synced')
  })

  it('refuses a refresh while locked, offline, syncing or spending', () => {
    expect(start({ session: 'locked' }).getSnapshot().can({ type: 'REFRESH' })).toBe(false)
    expect(start({ networkOnline: false }).getSnapshot().can({ type: 'REFRESH' })).toBe(false)
    expect(
      start({ health: health({ phase: 'syncing' }) }).getSnapshot().can({ type: 'REFRESH' }),
    ).toBe(false)
    expect(
      start({ coordinator: { ...coordinatorIdle, spend: 'active' } })
        .getSnapshot()
        .can({ type: 'REFRESH' }),
    ).toBe(false)
    const actor = start({ session: 'locked' })
    actor.send({ type: 'REFRESH' })
    expect(actor.getSnapshot().value).toBe('locked')
  })
})
