import { describe, expect, it } from 'vitest'
import { ONE_SAT_APP_CAPABILITIES } from './oneSatAppCapabilities.js'

describe('ONE_SAT_APP_CAPABILITIES', () => {
  it('advertises storage, provenance, and P1Sat without latch or unfinished catalog packs', () => {
    expect(ONE_SAT_APP_CAPABILITIES.brcs).toEqual(['147', '150', '164', '165'])
    expect(ONE_SAT_APP_CAPABILITIES.baskets).toEqual(['1sat'])
    expect(ONE_SAT_APP_CAPABILITIES).not.toHaveProperty('indexExpansion')
    expect(ONE_SAT_APP_CAPABILITIES.permissions).not.toHaveProperty('indexProtocol')

    const wire = JSON.stringify(ONE_SAT_APP_CAPABILITIES).toLowerCase()
    expect(wire).not.toContain('latch')
    expect(wire).not.toContain('156')
    expect(wire).not.toContain('v3')
    expect(wire).not.toContain('sigma')
  })
})
