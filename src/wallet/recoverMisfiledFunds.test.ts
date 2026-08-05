import { beforeEach, describe, expect, it, vi } from 'vitest'
import { P2PKH, PrivateKey } from '@bsv/sdk'

const resolveOneSatInscription = vi.fn()

vi.mock('./oneSatImport', () => ({
  resolveOneSatInscription: (...args: unknown[]) => resolveOneSatInscription(...args),
}))

vi.mock('./session', () => ({
  getActiveWallet: () => null,
}))

const { recoverMisfiledFunds } = await import('./recoverMisfiledFunds')

const KEY = PrivateKey.fromRandom()
const ADDRESS = KEY.toAddress()
const OWN_LOCK = new P2PKH().lock(ADDRESS).toHex()
const FOREIGN_LOCK = new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex()

type Output = { outpoint: string; satoshis: number; lockingScript: string }

function walletWith(outputs: Output[], createAction = vi.fn()) {
  return {
    address: ADDRESS,
    chain: 'main' as const,
    rootKeyHex: KEY.toHex(),
    wallet: {
      listOutputs: vi.fn(async ({ basket }: { basket: string }) => ({
        outputs: basket === '1sat' ? outputs : [],
      })),
      createAction,
    },
  } as never
}

describe('recoverMisfiledFunds', () => {
  beforeEach(() => {
    resolveOneSatInscription.mockReset()
  })

  it('sweeps funding outputs descended from an ordinal spend', async () => {
    // Ancestor walking would call with maxDepth > 0 and report these as inscribed.
    resolveOneSatInscription.mockResolvedValue(null)
    const createAction = vi.fn(async () => ({ txid: 'ff'.repeat(32) }))

    const result = await recoverMisfiledFunds(
      walletWith([{ outpoint: `${'ab'.repeat(32)}.0`, satoshis: 50_000, lockingScript: OWN_LOCK }], createAction),
    )

    expect(resolveOneSatInscription).toHaveBeenCalledWith(expect.any(String), 0, 'main', 0)
    expect(result.recoveredSats).toBe(50_000)
    expect(result.skipped).toEqual([])
    expect(createAction).toHaveBeenCalledOnce()
  })

  it('keeps inscribed outputs and reports why', async () => {
    resolveOneSatInscription.mockResolvedValue({ origin: `${'cd'.repeat(32)}_0` })
    const createAction = vi.fn()

    const result = await recoverMisfiledFunds(
      walletWith([{ outpoint: `${'ab'.repeat(32)}.0`, satoshis: 9_000, lockingScript: OWN_LOCK }], createAction),
    )

    expect(result.recoveredSats).toBe(0)
    expect(result.skipped).toEqual([
      { outpoint: `${'ab'.repeat(32)}.0`, satoshis: 9_000, reason: 'inscribed' },
    ])
    expect(createAction).not.toHaveBeenCalled()
  })

  it('reports a failed probe instead of silently sweeping', async () => {
    resolveOneSatInscription.mockRejectedValue(new Error('index offline'))

    const result = await recoverMisfiledFunds(
      walletWith([{ outpoint: `${'ab'.repeat(32)}.0`, satoshis: 9_000, lockingScript: OWN_LOCK }]),
    )

    expect(result.skipped[0]?.reason).toBe('probe-failed')
  })

  it('reports outputs locked to another key without probing', async () => {
    const result = await recoverMisfiledFunds(
      walletWith([{ outpoint: `${'ab'.repeat(32)}.0`, satoshis: 9_000, lockingScript: FOREIGN_LOCK }]),
    )

    expect(resolveOneSatInscription).not.toHaveBeenCalled()
    expect(result.skipped[0]?.reason).toBe('foreign-key')
  })

  it('reports dust left in place below the fee floor', async () => {
    resolveOneSatInscription.mockResolvedValue(null)

    const result = await recoverMisfiledFunds(
      walletWith([{ outpoint: `${'ab'.repeat(32)}.0`, satoshis: 300, lockingScript: OWN_LOCK }]),
    )

    expect(result.recoveredSats).toBe(0)
    expect(result.belowFloorSats).toBe(300)
  })

  it('returns the sweep error instead of throwing', async () => {
    resolveOneSatInscription.mockResolvedValue(null)
    const createAction = vi.fn(async () => {
      throw new Error('insufficient funds for fee')
    })

    const result = await recoverMisfiledFunds(
      walletWith([{ outpoint: `${'ab'.repeat(32)}.0`, satoshis: 50_000, lockingScript: OWN_LOCK }], createAction),
    )

    expect(result.error).toContain('insufficient funds')
  })
})
