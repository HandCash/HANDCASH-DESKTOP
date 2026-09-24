import { describe, expect, it, vi } from 'vitest'
import { resolveBsv21BurnInventory } from './token/burn'
import type { Bsv21SendTip } from './token/sendPlan'

const TOKEN_ID = `${'ab'.repeat(32)}_0`
const tip: Bsv21SendTip = {
  outpoint: `${'cd'.repeat(32)}_1`,
  tokenId: TOKEN_ID,
  amt: 425n,
  lockingScript: '51',
}

describe('resolveBsv21BurnInventory', () => {
  it('uses the live basket without consulting recovery', async () => {
    const recover = vi.fn(async () => [tip])
    await expect(
      resolveBsv21BurnInventory({ listed: [tip], recover }),
    ).resolves.toEqual({ source: 'basket', tips: [tip] })
    expect(recover).not.toHaveBeenCalled()
  })

  it('uses locally proven BEEF when Heal makes listOutputs look empty', async () => {
    await expect(
      resolveBsv21BurnInventory({
        listed: [],
        recover: async () => [tip],
      }),
    ).resolves.toEqual({ source: 'localBeef', tips: [tip] })
  })

  it('reports unavailable instead of claiming the token balance is zero', async () => {
    await expect(
      resolveBsv21BurnInventory({
        listed: [],
        recover: async () => [],
      }),
    ).resolves.toEqual({ source: 'unavailable', tips: [] })
  })
})
