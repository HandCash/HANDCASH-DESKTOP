import { describe, expect, it } from 'vitest'
import { resolveStatus } from './WalletStatusPill'
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
}

function health(patch: Partial<SyncHealth> = {}): SyncHealth {
  return {
    phase: 'ok',
    label: null,
    message: null,
    heldOneSats: 0,
    pendingTips: 0,
    updatedAt: 0,
    ...patch,
  }
}

describe('resolveStatus', () => {
  it('shows syncing payments while chain ingest is running', () => {
    const view = resolveStatus(
      'ready',
      health({
        phase: 'syncing',
        label: 'Syncing payments',
        message: 'Scanning your address for new payments',
      }),
      idleCloud,
      true,
      true,
      idlePayment,
    )
    expect(view.label).toBe('Syncing payments')
    expect(view.tone).toBe('busy')
    expect(view.detail).toMatch(/payments/i)
  })

  it('shows syncing items when that phase is active', () => {
    const view = resolveStatus(
      'ready',
      health({
        phase: 'syncing',
        label: 'Syncing items',
        message: 'Checking collectables against the chain',
      }),
      idleCloud,
      true,
      true,
      idlePayment,
    )
    expect(view.label).toBe('Syncing items')
  })

  it('prefers live payment phases over the generic sending session', () => {
    const view = resolveStatus(
      'sending',
      health(),
      idleCloud,
      true,
      true,
      {
        phase: 'broadcasting',
        label: 'Broadcasting…',
        detail: 'Signing and broadcasting your payment',
      },
    )
    expect(view.label).toBe('Broadcasting')
    expect(view.detail).toMatch(/Signing and broadcasting/i)
  })
})
