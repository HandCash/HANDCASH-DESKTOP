import { describe, expect, it } from 'vitest'
import { ONE_SAT_APP_CAPABILITIES } from './oneSatAppCapabilities.js'

describe('ONE_SAT_APP_CAPABILITIES', () => {
  it('advertises storage, provenance, and P1Sat permissions without latch vocabulary', () => {
    expect(ONE_SAT_APP_CAPABILITIES).toEqual({
      brcs: ['147', '150', '164', '165'],
      baskets: ['1sat'],
      permissions: {
        protocol: 'p 1sat',
        viewScopes: ['all', 'collection', 'app', 'creator', 'id'],
        spendLabel: 'p 1sat input id <key>',
      },
      provenanceVerify: ['v2'],
    })

    const wire = JSON.stringify(ONE_SAT_APP_CAPABILITIES).toLowerCase()
    expect(wire).not.toContain('latch')
    expect(wire).not.toContain('156')
    expect(wire).not.toContain('v3')
  })
})
