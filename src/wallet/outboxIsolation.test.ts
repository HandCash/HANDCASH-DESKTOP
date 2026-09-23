import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bindAccountLocalKeyScope,
  resetAccountLocalKeyScopeForTests,
} from './accountLocalKeys'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

vi.mock('./transactionTelemetry', () => ({
  activeTransactionTrace: () => null,
  recordTransactionStage: () => undefined,
}))

describe('runtime-owned propagation queues', () => {
  beforeEach(() => {
    store.clear()
    resetAccountLocalKeyScopeForTests()
  })

  it('never exposes one account BRC-29 outbox to another account', async () => {
    const {
      enqueuePendingBrc29Remit,
      pendingBrc29OutboxCount,
    } = await import('./pendingBrc29Outbox')
    const bind = (accountIndex: number, identityKey: string) =>
      bindAccountLocalKeyScope({ accountIndex, identityKey, chain: 'main' })
    const row = (n: number) => ({
      payeeIdentityKey: `02${'bb'.repeat(32)}`,
      senderIdentityKey: `03${'aa'.repeat(32)}`,
      txid: n.toString(16).padStart(2, '0').repeat(32),
      satoshis: n,
      remittance: {
        derivationPrefix: 'prefix',
        derivationSuffix: 'suffix',
        outputIndex: 0,
      },
    })

    bind(0, 'primary')
    enqueuePendingBrc29Remit(row(1))
    expect(pendingBrc29OutboxCount()).toBe(1)

    bind(1, 'minting')
    expect(pendingBrc29OutboxCount()).toBe(0)
    enqueuePendingBrc29Remit(row(2))
    expect(pendingBrc29OutboxCount()).toBe(1)

    bind(0, 'primary')
    expect(pendingBrc29OutboxCount()).toBe(1)
  })

  it('files a late remittance callback under its captured owner after a switch', async () => {
    const {
      enqueuePendingItemRemit,
      pendingItemOutboxCount,
    } = await import('./pendingItemOutbox')
    const primary = {
      accountIndex: 0,
      identityKey: 'primary',
      chain: 'main' as const,
    }
    bindAccountLocalKeyScope(primary)
    bindAccountLocalKeyScope({
      accountIndex: 1,
      identityKey: 'minting',
      chain: 'main',
    })

    enqueuePendingItemRemit(
      {
        payeeIdentityKey: `02${'bb'.repeat(32)}`,
        senderIdentityKey: `03${'aa'.repeat(32)}`,
        txid: '7a'.repeat(32),
        itemName: 'Late Fox',
      },
      primary,
    )

    expect(pendingItemOutboxCount()).toBe(0)
    bindAccountLocalKeyScope(primary)
    expect(pendingItemOutboxCount()).toBe(1)
  })
})
