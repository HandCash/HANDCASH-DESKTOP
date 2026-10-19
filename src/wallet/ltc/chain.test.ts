import { afterEach, describe, expect, it, vi } from 'vitest'
import { esploraLtcChain, failoverLtcChain, type LtcChain } from './chain'

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

describe('esploraLtcChain.txStatus', () => {
  const txid = 'cb'.repeat(32)
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function explorer(routes: Record<string, () => Response>) {
    const fetchMock = vi.fn(async (url: string) => {
      const path = url.replace('https://ltc.test/api', '')
      return routes[path]?.() ?? new Response('Transaction not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('refuses a txid the explorer has never seen though its status route says unconfirmed', async () => {
    explorer({ [`/tx/${txid}/status`]: () => Response.json({ confirmed: false }) })
    await expect(esploraLtcChain('https://ltc.test/api').txStatus(txid)).rejects.toThrow(/\b404\b/)
  })

  it('reports a mempool transaction as unconfirmed once its body is there', async () => {
    explorer({
      [`/tx/${txid}/status`]: () => Response.json({ confirmed: false }),
      [`/tx/${txid}/hex`]: () => new Response('0200'),
    })
    expect(await esploraLtcChain('https://ltc.test/api').txStatus(txid)).toEqual({ confirmed: false })
  })

  it('reports a confirmed transaction without fetching its body', async () => {
    const fetchMock = explorer({ [`/tx/${txid}/status`]: () => Response.json({ confirmed: true, block_height: 3197842 }) })
    expect(await esploraLtcChain('https://ltc.test/api').txStatus(txid)).toEqual({ confirmed: true, blockHeight: 3197842 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
