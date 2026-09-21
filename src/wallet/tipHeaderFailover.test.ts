import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { appendAppLog } from './appLog'
import { fetchBlockHeaderForHeight, peekHighestCachedHeader } from './blockHeaders'
import { wrapFindChainTipHeader } from './tipHeaderFailover'

vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))

vi.mock('./blockHeaders', () => ({
  fetchBlockHeaderForHeight: vi.fn(),
  peekHighestCachedHeader: vi.fn(),
}))

const HEADER = {
  height: 967307,
  hash: '0000000000000000056bb2564f85cc44d8f912bdd73a9b74105b979deead70c5',
  version: 1,
  previousHash: 'aa'.repeat(32),
  merkleRoot: 'bb'.repeat(32),
  time: 1,
  bits: 1,
  nonce: 1,
}

function stubFetch(ok: boolean, height = HEADER.height): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (!ok) throw new TypeError('Failed to fetch')
      return {
        ok: true,
        json: async () => ({ height }),
      } as unknown as Response
    }),
  )
}

beforeEach(() => {
  vi.mocked(fetchBlockHeaderForHeight).mockReset()
  vi.mocked(peekHighestCachedHeader).mockReset()
  vi.mocked(peekHighestCachedHeader).mockReturnValue(undefined)
  vi.mocked(appendAppLog).mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('wrapFindChainTipHeader', () => {
  it('returns the Bitails tip when the height header proves', async () => {
    stubFetch(true)
    vi.mocked(fetchBlockHeaderForHeight).mockResolvedValue(HEADER)
    const original = vi.fn(async () => {
      throw new Error('chaintracks down')
    })

    const find = wrapFindChainTipHeader('main', original)
    await expect(find()).resolves.toEqual(HEADER)
    expect(original).not.toHaveBeenCalled()
    expect(appendAppLog).toHaveBeenCalledWith(
      'info',
      '[headers] NewHeader tip from Bitails height 967307',
    )
  })

  it('holds the last live tip instead of throwing when every host drops', async () => {
    stubFetch(true)
    vi.mocked(fetchBlockHeaderForHeight).mockResolvedValue(HEADER)
    const original = vi.fn(async () => {
      throw new Error('chaintracks down')
    })
    const find = wrapFindChainTipHeader('main', original)
    await find()

    stubFetch(false)
    vi.mocked(fetchBlockHeaderForHeight).mockResolvedValue(undefined)
    await expect(find()).resolves.toEqual(HEADER)
    expect(appendAppLog).toHaveBeenCalledWith(
      'warn',
      '[headers] NewHeader holding last tip height 967307 — no live provider',
    )
    vi.mocked(appendAppLog).mockClear()
    await expect(find()).resolves.toEqual(HEADER)
    expect(appendAppLog).not.toHaveBeenCalled()
  })

  it('uses a cached header when this session has never seen a live tip', async () => {
    stubFetch(false)
    vi.mocked(peekHighestCachedHeader).mockReturnValue(HEADER)
    const original = vi.fn(async () => {
      throw new Error('chaintracks down')
    })
    const find = wrapFindChainTipHeader('main', original)
    await expect(find()).resolves.toEqual(HEADER)
  })

  it('throws only when there is no live tip and no last header to hold', async () => {
    stubFetch(false)
    const original = vi.fn(async () => {
      throw new Error('chaintracks down')
    })
    const find = wrapFindChainTipHeader('main', original)
    await expect(find()).rejects.toThrow('No chain tip header provider')
  })
})
