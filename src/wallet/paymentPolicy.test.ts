import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./deviceSync', () => ({
  hasDeviceLinkBackupUrl: vi.fn(() => false),
}))

describe('paymentPolicy offline gate', () => {
  const onlineDesc = Object.getOwnPropertyDescriptor(navigator, 'onLine')

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    if (onlineDesc) Object.defineProperty(navigator, 'onLine', onlineDesc)
  })

  it('blocks payments when offline', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    const { assertOnlineForPayment, offlinePaymentBlockedMessage } = await import(
      './paymentPolicy'
    )
    expect(offlinePaymentBlockedMessage()).toMatch(/offline/i)
    expect(() => assertOnlineForPayment()).toThrow(/offline/i)
  })

  it('allows payments when online', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
    const { assertOnlineForPayment, offlinePaymentBlockedMessage } = await import(
      './paymentPolicy'
    )
    expect(offlinePaymentBlockedMessage()).toBeNull()
    expect(() => assertOnlineForPayment()).not.toThrow()
  })
})
