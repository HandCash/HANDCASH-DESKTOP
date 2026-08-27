/**
 * Inscribed tips are invisible to address providers, so the ordinal index is
 * what stands between an incoming 1Sat / BSV-21 tip and a wallet that never
 * sees it. These tests pin the queries and the sat guard that keeps an indexer
 * from steering real funds into the sweep.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetTokenAddressScanCooldownForTests,
  scanAddressOrdinalTxos,
  scanAddressTokenTxos,
} from './tokenAddressScan'
import { mergeTokenTxos } from './ingestLegacyAddress'

const ADDRESS = '19aXSPsoR45Uuxk4LUonJ672zGFf57wfrD'
const TXID = '1a985778ab19fade1eecc04558793fbb4bc1cb66062baa9bf2068d198aacb313'
const NFT_TXID = '6eddee85e3470be56a295287f236d7ce63fcb09c5512d7703f7e03884c9326b9'

const tokenRow = (over: Record<string, unknown> = {}) => ({
  txid: TXID,
  vout: 0,
  outpoint: `${TXID}_0`,
  satoshis: 1,
  height: 963591,
  spend: '',
  ...over,
})

beforeEach(() => {
  resetTokenAddressScanCooldownForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetTokenAddressScanCooldownForTests()
})

describe('scanAddressTokenTxos', () => {
  it('asks the index for token outputs — the default query omits them', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await scanAddressTokenTxos(ADDRESS, 'main')

    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toContain(`/api/txos/address/${ADDRESS}/unspent`)
    expect(url).toContain('bsv20=true')
  })

  it('returns the tip the address providers cannot see', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify([tokenRow()]), { status: 200 })),
    )

    const utxos = await scanAddressTokenTxos(ADDRESS, 'main')

    expect(utxos).toEqual([
      { outpoint: `${TXID}.0`, txid: TXID, vout: 0, satoshis: 1, height: 963591 },
    ])
  })

  it('drops spent rows and anything that is not a 1-sat tip', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              tokenRow({ vout: 1, spend: 'ab'.repeat(32) }),
              tokenRow({ vout: 2, satoshis: 23_259_098 }),
              tokenRow({ vout: 3, satoshis: 0 }),
              tokenRow({ vout: 4, txid: 'not-a-txid' }),
            ]),
            { status: 200 },
          ),
      ),
    )

    await expect(scanAddressTokenTxos(ADDRESS, 'main')).resolves.toEqual([])
  })

  it('degrades instead of rejecting when the wallet has no address yet', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      scanAddressTokenTxos(undefined as unknown as string, 'main'),
    ).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('degrades to no tokens rather than failing the whole Refresh', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('index offline')
      }),
    )

    await expect(scanAddressTokenTxos(ADDRESS, 'main')).resolves.toEqual([])
  })

  it('skips the index while it is cooling down after a failure', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('index offline')
    })
    vi.stubGlobal('fetch', fetchMock)

    await scanAddressTokenTxos(ADDRESS, 'main')
    await scanAddressTokenTxos(ADDRESS, 'main')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('scanAddressOrdinalTxos', () => {
  it('asks the index without bsv20 so NFT ords are included', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await scanAddressOrdinalTxos(ADDRESS, 'main')

    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toContain(`/api/txos/address/${ADDRESS}/unspent`)
    expect(url).not.toContain('bsv20=true')
  })

  it('returns self-sent 1Sat tips WOC cannot list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              tokenRow({
                txid: NFT_TXID,
                outpoint: `${NFT_TXID}_0`,
                height: 964166,
              }),
            ]),
            { status: 200 },
          ),
      ),
    )

    const utxos = await scanAddressOrdinalTxos(ADDRESS, 'main')
    expect(utxos).toEqual([
      {
        outpoint: `${NFT_TXID}.0`,
        txid: NFT_TXID,
        vout: 0,
        satoshis: 1,
        height: 964166,
      },
    ])
  })
})

describe('mergeTokenTxos', () => {
  const scan = (utxos: Array<{ vout: number; satoshis: number }>) => ({
    address: ADDRESS,
    chain: 'main' as const,
    sats: utxos.reduce((s, u) => s + u.satoshis, 0),
    utxos: utxos.map((u) => ({
      outpoint: `${TXID}.${u.vout}`,
      txid: TXID,
      vout: u.vout,
      satoshis: u.satoshis,
    })),
    source: 'whatsonchain' as const,
  })

  const tip = { outpoint: `${TXID}.0`, txid: TXID, vout: 0, satoshis: 1 }

  it('carries a token tip into an otherwise empty scan', () => {
    const merged = mergeTokenTxos(scan([]), [tip])
    expect(merged.utxos).toEqual([tip])
    expect(merged.sats).toBe(1)
  })

  it('leaves the provider row alone when both sources saw the output', () => {
    const base = scan([{ vout: 0, satoshis: 1 }])
    expect(mergeTokenTxos(base, [tip])).toBe(base)
  })

  it('returns the scan untouched when the index found nothing', () => {
    const base = scan([{ vout: 5, satoshis: 5_000 }])
    expect(mergeTokenTxos(base, [])).toBe(base)
  })
})
