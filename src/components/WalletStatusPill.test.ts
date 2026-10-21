import { describe, expect, it } from 'vitest'
import { pillLabel, resolveStatus } from './WalletStatusPill'
import type { SyncHealth } from '../wallet/walletHealth'
import type { CloudBackupHealth } from '../wallet/cloudBackupHealth'
import type { WalletProgress } from '../wallet/walletProgress'
import type { WalletCoordinatorLiveStatus } from '../wallet/walletCoordinator'
import type { WalletStatusContext } from '../machines/walletStatusMachine'

const idleCloud: CloudBackupHealth = {
  phase: 'off',
  label: 'Off',
  message: null,
  checkedAt: 0,
}

const idleWalletProgress: WalletProgress = {
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

const idleCoordinator: WalletCoordinatorLiveStatus = {
  chainIngest: 'idle',
  spend: 'idle',
  historyReplica: 'idle',
  recompose: 'idle',
  spendWaiting: 0,
  summary: 'idle',
}

function health(patch: Partial<SyncHealth> = {}): SyncHealth {
  return {
    phase: 'ok',
    reason: null,
    message: null,
    heldOneSats: 0,
    pendingTips: 0,
    updatedAt: 0,
    identityKey: null,
    accountIndex: null,
    ...patch,
  }
}

function status(patch: Partial<WalletStatusContext> = {}) {
  return resolveStatus({
    session: 'ready',
    health: health(),
    cloud: idleCloud,
    networkOnline: true,
    bridgeOnline: true,
    progress: idleWalletProgress,
    coordinator: idleCoordinator,
    refreshing: false,
    ...patch,
  })
}

describe('resolveStatus', () => {
  it('keeps syncing short enough for the status bubble', () => {
    const view = status({
      health: health({ phase: 'syncing', message: 'Looking for new payments on your address' }),
    })
    expect(view.label).toBe('Syncing')
    expect(view.tone).toBe('busy')
    expect(view.detail).toMatch(/payments/i)
  })

  it('a busy backup host reads as delayed, not failed', () => {
    const delayed: CloudBackupHealth = {
      phase: 'delayed',
      label: 'Backup delayed',
      message: 'Backup host is not accepting requests (503: store-unavailable). Retrying after 14:05.',
      checkedAt: 0,
    }
    const view = status({ cloud: delayed })
    expect(view.label).toBe('Backup delayed')
    expect(view.tone).toBe('warn')
    expect(view.detail).toMatch(/catches up automatically/)
    const failed = status({ cloud: { ...delayed, phase: 'error', label: 'Backup failed' } })
    expect(failed.label).toBe('Backup failed')
    expect(failed.tone).toBe('error')
  })

  it('never shows send progress: sync failure stays visible during a send', () => {
    const view = status({
      session: 'sending',
      health: health({ phase: 'error', message: 'indexer down' }),
      coordinator: { ...idleCoordinator, spend: 'active' },
    })
    expect(view.label).toBe('Sync failed')
  })

  it('shows Synced when chain is ok', () => {
    const view = status()
    expect(view.label).toBe('Synced')
    expect(view.tone).toBe('ok')
  })

  it('does not claim Synced while chain ingest still holds the spend lock', () => {
    const view = status({
      coordinator: { ...idleCoordinator, chainIngest: 'active', summary: 'active: chainIngest' },
    })
    expect(view.label).toBe('Catching up')
    expect(view.tone).toBe('busy')
    expect(view.detail).toBe('active: chainIngest')
  })

  it('shows Catching up while progress bus is still running after soft Syncing clear', () => {
    const view = status({
      health: health({ message: 'Still importing collectables in the background…' }),
      progress: {
        ...idleWalletProgress,
        kind: 'refresh',
        phase: 'catching-up',
        status: 'running',
        current: 48,
        total: 200,
        message: 'Still importing collectables…',
      },
    })
    expect(view.label).toBe('Catching up')
    expect(view.tone).toBe('busy')
    expect(view.detail).toMatch(/Still importing/i)
  })

  it('a still-importing reason shows Catching up with its message', () => {
    const view = status({
      health: health({
        reason: 'stillImporting',
        message: 'Still importing in the background…',
      }),
    })
    expect(view.label).toBe('Catching up')
    expect(view.tone).toBe('busy')
    expect(view.detail).toMatch(/Still importing/)
  })

  it('a timeout reason shows Network slow', () => {
    const view = status({
      health: health({
        reason: 'timeout',
        message: 'Refresh took too long — showing local balance.',
      }),
    })
    expect(view.label).toBe('Network slow')
    expect(view.tone).toBe('warn')
    expect(view.detail).toMatch(/local balance/)
  })

  it('a manual refresh reads as Syncing', () => {
    const view = status({ refreshing: true })
    expect(view.label).toBe('Syncing')
    expect(view.detail).toMatch(/Refreshing funds and history/)
  })
})

describe('pillLabel', () => {
  it('strips trailing ellipsis for uniform uppercase labels', () => {
    expect(pillLabel('Syncing…')).toBe('Syncing')
    expect(pillLabel('Preparing...')).toBe('Preparing')
    expect(pillLabel('Synced')).toBe('Synced')
  })
})
