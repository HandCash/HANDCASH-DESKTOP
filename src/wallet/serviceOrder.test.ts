import { describe, expect, it } from 'vitest'

import {
  POST_BEEF_PREFER,
  configurePostBeefServices,
  preferServiceOrder,
} from './serviceOrder'

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

  it('keeps Arcade V2 as the only transaction broadcaster', () => {
    const services = [
      { name: 'GorillaPoolArcBeef' },
      { name: 'Bitails' },
      { name: 'WhatsOnChain' },
      { name: 'TaalArcBeef' },
      { name: 'ArcadeBeef' },
    ]
    configurePostBeefServices({ services })
    expect(services[0]?.name).toBe('ArcadeBeef')
    expect(services.map((s) => s.name)).toEqual([...POST_BEEF_PREFER])
  })
})
