import { describe, expect, it, vi } from 'vitest'
import { failoverLtcChain, type LtcChain } from './chain'

function chain(over: Partial<LtcChain>): LtcChain {
  const down = async () => {
    throw new Error('explorer down')
  }
  return {
    tipHeight: down,
    blockHashAt: down,
    header: down,
    txHex: down,
    txStatus: down,
    merkleProof: down,
    addressUtxos: down,
    broadcast: down,
    feeRate: down,
    ...over,
  }
}

describe('failoverLtcChain', () => {
  it('asks the next explorer when one is down, and stops at the first answer', async () => {
    const third = vi.fn(async () => 3)
    const failover = failoverLtcChain([chain({}), chain({ tipHeight: async () => 3197237 }), chain({ tipHeight: third })])
    expect(await failover.tipHeight()).toBe(3197237)
    expect(third).not.toHaveBeenCalled()
  })

  it('passes arguments through and reports the last error when all are down', async () => {
    const blockHashAt = vi.fn(async (height: number) => `${height}`)
    expect(await failoverLtcChain([chain({}), chain({ blockHashAt })]).blockHashAt(7)).toBe('7')
    expect(blockHashAt).toHaveBeenCalledWith(7)
    await expect(failoverLtcChain([chain({}), chain({})]).txHex('a'.repeat(64))).rejects.toThrow('explorer down')
  })
})
