import { describe, expect, it } from 'vitest'
import {
  clearPaymentProgress,
  getPaymentProgress,
  isOutpointSending,
  setPaymentProgress,
} from './paymentProgress'

describe('paymentProgress', () => {
  it('exposes Sending label for preparing / broadcasting / finishing', () => {
    setPaymentProgress('preparing')
    expect(getPaymentProgress().label).toBe('Sending…')
    expect(getPaymentProgress().detail).toMatch(/spendable/i)

    setPaymentProgress('broadcasting', 'Signing and broadcasting your payment')
    expect(getPaymentProgress().phase).toBe('broadcasting')
    expect(getPaymentProgress().detail).toBe('Signing and broadcasting your payment')
    expect(getPaymentProgress().label).toBe('Sending…')

    setPaymentProgress('finishing')
    expect(getPaymentProgress().label).toBe('Sending…')

    clearPaymentProgress()
    expect(getPaymentProgress().phase).toBe('idle')
    expect(getPaymentProgress().label).toBeNull()
  })

  it('tracks the collectable outpoint across phase updates', () => {
    setPaymentProgress('preparing', 'Waiting', 'txid.0')
    expect(getPaymentProgress().outpoint).toBe('txid_0')
    expect(isOutpointSending('txid_0')).toBe(true)
    expect(isOutpointSending('txid.0')).toBe(true)
    expect(isOutpointSending('other_1')).toBe(false)

    setPaymentProgress('broadcasting', 'Broadcasting')
    expect(getPaymentProgress().outpoint).toBe('txid_0')
    expect(isOutpointSending('txid_0')).toBe(true)

    clearPaymentProgress()
    expect(isOutpointSending('txid_0')).toBe(false)
  })
})
