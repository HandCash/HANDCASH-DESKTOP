import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  announceSpendCompleted,
  resetSpendAnnouncementsForTests,
} from './spendAnnounce'

class TestCustomEvent<T> {
  constructor(
    public type: string,
    public init: { detail: T },
  ) {}

  get detail(): T {
    return this.init.detail
  }
}

describe('spend announcement', () => {
  const dispatchEvent = vi.fn()

  beforeEach(() => {
    dispatchEvent.mockReset()
    resetSpendAnnouncementsForTests()
    vi.stubGlobal('document', { dispatchEvent })
    vi.stubGlobal('CustomEvent', TestCustomEvent)
  })

  it('dispatches one notification per completed transaction', () => {
    const txid = 'a'.repeat(64)
    announceSpendCompleted({
      txid,
      sats: 1000,
      method: 'createAction',
      note: 'Transaction Bounce test payment',
    })
    // A batch may record several Activity legs for the same transaction.
    announceSpendCompleted({
      txid,
      sats: 1,
      method: 'send-collectable',
      item: { name: 'Fox' },
    })

    expect(dispatchEvent).toHaveBeenCalledOnce()
    const event = dispatchEvent.mock.calls[0]![0] as TestCustomEvent<{
      title: string
      body: string
      txid: string
    }>
    expect(event.type).toBe('handcash:spend')
    expect(event.detail).toMatchObject({
      title: 'Payment sent',
      txid,
    })
    expect(event.detail.body).toContain('Transaction Bounce test payment')
  })

  it('refuses to announce an entry without a real transaction id', () => {
    announceSpendCompleted({
      txid: 'local-pending',
      sats: 1000,
      method: 'send',
    })
    expect(dispatchEvent).not.toHaveBeenCalled()
  })
})
