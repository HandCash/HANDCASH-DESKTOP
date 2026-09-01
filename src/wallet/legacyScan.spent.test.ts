import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyBitailsUtxoStatus,
  parseOutpoint,
  resetLegacyScanCooldownForTests,
  spentStatusOfOutpoint,
} from './legacyScan'

const PREV = 'ab'.repeat(32)
const SPEND = 'cd'.repeat(32)

afterEach(() => {
  vi.unstubAllGlobals()
  resetLegacyScanCooldownForTests()
})

describe('parseOutpoint', () => {
  it('accepts dotted and underscored keys', () => {
    expect(parseOutpoint(`${PREV}.1`)).toEqual({ txid: PREV, vout: 1 })
    expect(parseOutpoint(`${PREV}_2`)).toEqual({ txid: PREV, vout: 2 })
  })

  it('rejects junk', () => {
    expect(parseOutpoint('nope')).toBeNull()
    expect(parseOutpoint(`${PREV}.x`)).toBeNull()
  })
})

describe('classifyBitailsUtxoStatus', () => {
  it('treats a positive spent flag as spent', () => {
    expect(classifyBitailsUtxoStatus({ status: 'exists', spent: true })).toBe('spent')
  })

  it('treats exists/mempool plus spent false as unspent', () => {
    expect(classifyBitailsUtxoStatus({ status: 'exists', spent: false })).toBe(
      'unspent',
    )
    expect(classifyBitailsUtxoStatus({ status: 'mempool', spent: false })).toBe(
      'unspent',
    )
  })

  it('fails closed on Bitails unknown — that is spent or never seen', () => {
    expect(classifyBitailsUtxoStatus({ status: 'unknown' })).toBe('unknown')
  })
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('spentStatusOfOutpoint', () => {
  it('returns spent from Bitails without asking WhatsOnChain', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/v1/chain/spent/')) {
        return new Response('', { status: 503 })
      }
      if (String(url).includes('/output/0/status')) {
        return jsonResponse(200, { status: 'exists', spent: true })
      }
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(spentStatusOfOutpoint(`${PREV}.0`, 'main')).resolves.toBe('spent')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns unspent from BananaBlocks 404 without asking WhatsOnChain', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('bananablocks')) {
          return new Response('', { status: 404 })
        }
        throw new Error(`unexpected ${url}`)
      }),
    )

    await expect(spentStatusOfOutpoint(`${PREV}.0`, 'main')).resolves.toBe('unspent')
  })

  it('does not treat Bitails unknown plus a WhatsOnChain 404 as spent', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('bananablocks')) {
        return new Response('', { status: 500 })
      }
      if (String(url).includes('bitails')) {
        return jsonResponse(200, { status: 'unknown' })
      }
      return new Response('', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(spentStatusOfOutpoint(`${PREV}.0`, 'main')).resolves.toBe('unknown')
  })

  it('accepts a WhatsOnChain spend txid after Bitails is unknown', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('bitails')) {
        return jsonResponse(200, { status: 'unknown' })
      }
      return jsonResponse(200, { txid: SPEND })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(spentStatusOfOutpoint(`${PREV}.0`, 'main')).resolves.toBe('spent')
  })
})
