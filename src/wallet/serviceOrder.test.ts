import { describe, expect, it } from 'vitest'

import { POST_BEEF_PREFER, preferServiceOrder } from './serviceOrder'

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

  it('puts ArcadeBeef first so the first success completes the send', () => {
    const services = [
      { name: 'GorillaPoolArcBeef' },
      { name: 'Bitails' },
      { name: 'WhatsOnChain' },
      { name: 'TaalArcBeef' },
      { name: 'ArcadeBeef' },
    ]
    preferServiceOrder({ services }, POST_BEEF_PREFER)
    expect(services[0]?.name).toBe('ArcadeBeef')
    expect(services.map((s) => s.name)).toEqual([...POST_BEEF_PREFER])
  })
})
