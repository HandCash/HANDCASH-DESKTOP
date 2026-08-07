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
    expect(view.label).toBe('Syncing…')
    expect(view.tone).toBe('busy')
    expect(view.detail).toMatch(/payments/i)
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
