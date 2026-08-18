import { describe, expect, it } from 'vitest'
import { ONE_SAT_APP_CAPABILITIES } from './oneSatAppCapabilities.js'

describe('ONE_SAT_APP_CAPABILITIES', () => {
  it('advertises BRC-147 and BRC-150 without withdrawn latch vocabulary', () => {
    expect(ONE_SAT_APP_CAPABILITIES).toEqual({
      brcs: ['147', '150'],
      baskets: ['1sat'],
      provenanceVerify: ['v2'],
    })

    const wire = JSON.stringify(ONE_SAT_APP_CAPABILITIES).toLowerCase()
    expect(wire).not.toContain('latch')
    expect(wire).not.toContain('156')
    expect(wire).not.toContain('v3')
  })
})
