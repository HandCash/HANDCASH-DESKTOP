import { describe, expect, it } from 'vitest'

import { preferServiceOrder } from './serviceOrder'

describe('preferServiceOrder', () => {
  it('moves preferred providers to the front without dropping others', () => {
    const services = [
      { name: 'WhatsOnChain' },
      { name: 'Bitails' },
      { name: 'Arcade' },
    ]
    preferServiceOrder({ services, reset() {} }, ['Arcade', 'Bitails', 'WhatsOnChain'])
    expect(services.map((s) => s.name)).toEqual(['Arcade', 'Bitails', 'WhatsOnChain'])
  })

  it('ignores unknown preferred names', () => {
    const services = [{ name: 'WhatsOnChain' }, { name: 'Bitails' }]
    preferServiceOrder({ services }, ['Missing', 'Bitails'])
    expect(services.map((s) => s.name)).toEqual(['Bitails', 'WhatsOnChain'])
  })
})
