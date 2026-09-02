import { describe, expect, it, vi, beforeEach } from 'vitest'
import { rememberProvenVerdict } from './provenCache'
import { addMarketOriginVerdicts, listMarketBasketOutputs } from './marketInventory'

const listOutputsWithTimeout = vi.fn()
const getCachedCollectables = vi.fn()
const getCachedFungibles = vi.fn()
const getWalletCoordinatorSnapshot = vi.fn()
const shouldYieldChainIngestToSpend = vi.fn()

vi.mock('./collectables', () => ({
  listOutputsWithTimeout: (...args: unknown[]) => listOutputsWithTimeout(...args),
  getCachedCollectables: () => getCachedCollectables(),
}))

vi.mock('./fungibles', () => ({
  getCachedFungibles: () => getCachedFungibles(),
}))

vi.mock('./walletCoordinator', () => ({
  getWalletCoordinatorSnapshot: () => getWalletCoordinatorSnapshot(),
  shouldYieldChainIngestToSpend: () => shouldYieldChainIngestToSpend(),
}))

describe('market inventory listOutputs fast path', () => {
  beforeEach(() => {
    listOutputsWithTimeout.mockReset()
    getCachedCollectables.mockReset()
    getCachedFungibles.mockReset()
    getWalletCoordinatorSnapshot.mockReturnValue({
      chainIngest: 'idle',
      spend: 'idle',
    })
    shouldYieldChainIngestToSpend.mockReturnValue(false)
  })

  it('serves cached 1sat rows when the wallet is busy', async () => {
    getWalletCoordinatorSnapshot.mockReturnValue({
      chainIngest: 'active',
      spend: 'idle',
    })
    getCachedCollectables.mockReturnValue([
      {
        outpoint: `${'a'.repeat(64)}.1`,
        origin: `${'b'.repeat(64)}_0`,
        name: 'Fox',
        satoshis: 1,
        imageUrl: '',
        traits: [],
        extras: [],
        proven: true,
        authenticity: 'brc150',
      },
    ])

    const wallet = { listOutputs: vi.fn() }
    const result = await listMarketBasketOutputs(wallet as never, { basket: '1sat' })
    expect(result.outputs).toHaveLength(1)
    expect(listOutputsWithTimeout).not.toHaveBeenCalled()
  })

  it('serves cached rows immediately even when the wallet is idle', async () => {
    getCachedCollectables.mockReturnValue([
      {
        outpoint: `${'a'.repeat(64)}.1`,
        origin: `${'b'.repeat(64)}_0`,
        name: 'Fox',
        satoshis: 1,
        imageUrl: '',
        traits: [],
        extras: [],
        proven: true,
        authenticity: 'brc150',
      },
    ])
    listOutputsWithTimeout.mockImplementation(
      () => new Promise(() => undefined),
    )
    const wallet = { listOutputs: vi.fn() }
    const result = await listMarketBasketOutputs(wallet as never, { basket: '1sat' })
    expect(result.outputs).toHaveLength(1)
  })

  it('falls back to cached bsv21 rows after a live read times out', async () => {
    listOutputsWithTimeout.mockRejectedValue(new Error('listOutputs timed out'))
    getCachedFungibles.mockReturnValue([
      {
        tokenId: `${'c'.repeat(64)}.0`,
        sym: 'KING',
        amt: '60',
        dec: 0,
        utxoCount: 1,
        outpoint: `${'d'.repeat(64)}.2`,
        spendKind: 'plain',
      },
    ])

    const wallet = { listOutputs: vi.fn() }
    const result = await listMarketBasketOutputs(wallet as never, { basket: 'bsv21' })
    expect(result.outputs).toHaveLength(1)
    expect((result.outputs?.[0] as { tags?: string[] }).tags).toContain('bsv21')
  })
})

describe('market inventory authenticity projection', () => {
  it('exposes only the durable BRC-150 verdict as originVerified', () => {
    const proven = `${'a'.repeat(64)}.0`
    const unproven = `${'b'.repeat(64)}.1`
    rememberProvenVerdict(proven, 'brc150')
    rememberProvenVerdict(unproven, 'unproven')

    expect(
      addMarketOriginVerdicts({
        outputs: [{ outpoint: proven }, { outpoint: unproven }, { outpoint: 'bad' }],
      }),
    ).toMatchObject({
      outputs: [
        { authenticity: 'brc150', originVerified: true },
        { authenticity: 'unproven', originVerified: false },
        { authenticity: 'unproven', originVerified: false },
      ],
    })
  })

  it('names the origin the wallet proved, not the one metadata claims', () => {
    const tip = `${'c'.repeat(64)}.0`
    const origin = `${'d'.repeat(64)}_7`
    rememberProvenVerdict(tip, { tier: 'brc150', origin, verifiedAt: Date.now() })

    const projected = addMarketOriginVerdicts({
      outputs: [
        {
          outpoint: tip,
          customInstructions: JSON.stringify({ origin: `${'e'.repeat(64)}_1` }),
        },
      ],
    }) as { outputs: { provenOrigin?: string | null }[] }
    expect(projected.outputs[0].provenOrigin).toBe(origin)
  })

  it('offers no origin for a tip the wallet has not proven', () => {
    const projected = addMarketOriginVerdicts({
      outputs: [{ outpoint: `${'f'.repeat(64)}.3` }],
    }) as { outputs: { provenOrigin?: string | null; originVerified?: boolean }[] }
    expect(projected.outputs[0]).toMatchObject({
      originVerified: false,
      provenOrigin: null,
    })
  })
})
