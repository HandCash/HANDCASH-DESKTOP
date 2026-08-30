import { describe, expect, it } from 'vitest'
import { defaultReceiveMode } from './ReceivePanel'

describe('defaultReceiveMode', () => {
  it('prefers the standard payment address for compatibility with other BSV wallets', () => {
    expect(defaultReceiveMode()).toBe('address')
  })
})
