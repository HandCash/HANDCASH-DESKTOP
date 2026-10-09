import { afterEach, describe, expect, it, vi } from 'vitest'
import { scanAddressViaBananaBlocks, scanAddressViaBitails, scanAddressViaWhatsOnChain } from './legacyScan'

const ADDRESS = '1NymF2qG3VoDb56SWwsTK12cc5ZhSsXYxY'
const txid = (n: number) => n.toString(16).padStart(64, '0')

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('address scans read every page', () => {
  it('Bitails: pages past the first thousand rows', async () => {
    const all = Array.from({ length: 2_821 }, (_, i) => ({ txid: txid(i), vout: 0, satoshis: 1 }))
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      const q = new URL(url).searchParams
      const from = Number(q.get('from') ?? 0)
      const limit = Number(q.get('limit') ?? 1_000)
      return new Response(JSON.stringify({ unspent: all.slice(from, from + Math.min(limit, 1_000)) }))
    }))

    const scan = await scanAddressViaBitails(ADDRESS, 'main')

    expect(scan.utxos).toHaveLength(2_821)
    expect(scan.utxos.at(-1)?.outpoint).toBe(`${txid(2_820)}.0`)
    expect(scan.sats).toBe(2_821)
    expect(urls).toHaveLength(3)
  })

  it('WhatsOnChain: follows the page token and adds mempool outputs', async () => {
    const confirmed = Array.from({ length: 1_500 }, (_, i) => ({ tx_hash: txid(i), tx_pos: 0, value: 1, height: 1 }))
    const mempool = [{ tx_hash: txid(9_999), tx_pos: 9, value: 1 }]
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/unconfirmed/unspent')) return new Response(JSON.stringify({ result: mempool }))
      const token = new URL(url).searchParams.get('token')
      const from = token ? Number(token) : 0
      const page = confirmed.slice(from, from + 1_000)
      const next = from + page.length < confirmed.length ? String(from + page.length) : null
      return new Response(JSON.stringify({ result: page, nextPageToken: next }))
    }))

    const scan = await scanAddressViaWhatsOnChain(ADDRESS, 'main')

    expect(scan.utxos).toHaveLength(1_501)
    expect(scan.utxos.some((u) => u.outpoint === `${txid(9_999)}.9`)).toBe(true)
  }, 20_000)

  it('a single-page host that fills its cap refuses rather than standing in for the set', async () => {
    const page = Array.from({ length: 1_000 }, (_, i) => ({ tx_hash: txid(i), tx_pos: 0, value: 1, height: 1 }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(page))))

    await expect(scanAddressViaBananaBlocks(ADDRESS, 'main')).rejects.toThrow(/the set is longer/)
  })
})
