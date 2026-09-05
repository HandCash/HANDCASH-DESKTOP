import { describe, expect, it } from 'vitest'
import { defaultReceiveMode } from './ReceivePanel'

describe('defaultReceiveMode', () => {
  it('defaults to PeerPay for HandCash identity payments', () => {
    expect(defaultReceiveMode()).toBe('peerpay')
  })
})
