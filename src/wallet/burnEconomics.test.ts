import { describe, expect, it } from 'vitest'
import { estimateBurnEconomics } from './burnEconomics'

describe('estimateBurnEconomics', () => {
  it('separates token protocol outputs from physical sats recovered', () => {
    expect(
      estimateBurnEconomics({
        inputCount: 3,
        protocolOutputCount: 1,
        recoveryOutput: true,
      }),
    ).toMatchObject({
      grossAssetSats: 3,
      protocolOutputSats: 1,
      recoverableSats: 2,
    })
  })

  it('shows that a one-item burn costs more Pay than it recovers', () => {
    const preview = estimateBurnEconomics({
      inputCount: 1,
      protocolOutputCount: 0,
      recoveryOutput: true,
    })
    expect(preview.recoverableSats).toBe(1)
    expect(preview.estimatedPayEffectSats).toBeLessThan(0)
  })
})
