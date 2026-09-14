import { describe, expect, it } from 'vitest'
import { ONE_SAT_APP_CAPABILITIES } from './oneSatAppCapabilities.js'

describe('ONE_SAT_APP_CAPABILITIES', () => {
  it('advertises storage, provenance, P1Sat, and BRC-230 index without latch vocabulary', () => {
    expect(ONE_SAT_APP_CAPABILITIES.brcs).toContain('230')
    expect(ONE_SAT_APP_CAPABILITIES.baskets).toContain('index')
    expect(ONE_SAT_APP_CAPABILITIES.indexExpansion?.methods).toContain(
      'installIndexExpansion',
    )
    expect(ONE_SAT_APP_CAPABILITIES.indexExpansion?.methods).toContain('overlayLookup')
    expect(ONE_SAT_APP_CAPABILITIES.permissions.indexProtocol).toBe('p index')

    const wire = JSON.stringify(ONE_SAT_APP_CAPABILITIES).toLowerCase()
    expect(wire).not.toContain('latch')
    expect(wire).not.toContain('156')
    expect(wire).not.toContain('v3')
    expect(wire).not.toContain('sigma')
  })
})
