import { describe, expect, it } from 'vitest'
import {
  clearPaymentProgress,
  getPaymentProgress,
  setPaymentProgress,
} from './paymentProgress'

describe('paymentProgress', () => {
  it('exposes preparing / broadcasting / finishing copy', () => {
    setPaymentProgress('preparing')
    expect(getPaymentProgress().label).toBe('Preparing…')
    expect(getPaymentProgress().detail).toMatch(/spendable/i)

    setPaymentProgress('broadcasting', 'Signing and broadcasting your payment')
    expect(getPaymentProgress().phase).toBe('broadcasting')
    expect(getPaymentProgress().detail).toBe('Signing and broadcasting your payment')

    setPaymentProgress('finishing')
    expect(getPaymentProgress().label).toBe('Finishing…')

    clearPaymentProgress()
    expect(getPaymentProgress().phase).toBe('idle')
    expect(getPaymentProgress().label).toBeNull()
  })
})
