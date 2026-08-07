import { describe, expect, it } from 'vitest'
import { pillLabel, resolveStatus } from './WalletStatusPill'
import type { SyncHealth } from '../wallet/walletHealth'
import type { CloudBackupHealth } from '../wallet/cloudBackupHealth'
import type { PaymentProgress } from '../wallet/paymentProgress'

const idleCloud: CloudBackupHealth = {
  phase: 'off',
  label: 'Off',
  message: null,
  checkedAt: 0,
}

const idlePayment: PaymentProgress = {
  phase: 'idle',
  label: null,
  detail: null,
  outpoint: null,
}

function health(patch: Partial<SyncHealth> = {}): SyncHealth {
  return {
    phase: 'ok',
    message: null,
    heldOneSats: 0,
    pendingTips: 0,
    updatedAt: 0,
    ...patch,
  }
}

describe('resolveStatus', () => {
  it('keeps syncing short enough for the status bubble', () => {
    const view = resolveStatus(
      'ready',
      health({
        phase: 'syncing',
        message: 'Looking for new payments on your address',
      }),
      idleCloud,
      true,
      true,
      idlePayment,
    )
    expect(view.label).toBe('Syncing')
    expect(view.tone).toBe('busy')
    expect(view.detail).toMatch(/payments/i)
  })

  it('normalizes payment labels without trailing ellipsis', () => {
    const view = resolveStatus(
      'sending',
      health(),
      idleCloud,
      true,
      true,
      {
        phase: 'broadcasting',
        label: 'Sending…',
        detail: 'Signing and broadcasting your payment',
        outpoint: null,
      },
    )
    expect(view.label).toBe('Sending')
    expect(view.detail).toMatch(/Signing and broadcasting/i)
  })

  it('keeps Sending visible over sync failure while a payment is in flight', () => {
    const view = resolveStatus(
      'ready',
      health({ phase: 'error', message: 'indexer down' }),
      idleCloud,
      true,
      true,
      {
        phase: 'preparing',
        label: 'Sending…',
        detail: 'Waiting to send the collectable',
        outpoint: 'abc_0',
      },
    )
    expect(view.label).toBe('Sending')
    expect(view.tone).toBe('busy')
  })

  it('keeps Sending visible over Syncing', () => {
    const view = resolveStatus(
      'ready',
      health({ phase: 'syncing', message: 'Refreshing funds' }),
      idleCloud,
      true,
      true,
      {
        phase: 'building',
        label: 'Sending…',
        detail: 'Assembling the transaction',
        outpoint: null,
      },
    )
    expect(view.label).toBe('Sending')
  })

  it('shows Synced when chain is ok', () => {
    const view = resolveStatus('ready', health(), idleCloud, true, true, idlePayment)
    expect(view.label).toBe('Synced')
    expect(view.tone).toBe('ok')
  })
})

describe('pillLabel', () => {
  it('strips trailing ellipsis for uniform uppercase labels', () => {
    expect(pillLabel('Syncing…')).toBe('Syncing')
    expect(pillLabel('Preparing...')).toBe('Preparing')
    expect(pillLabel('Synced')).toBe('Synced')
  })
})
