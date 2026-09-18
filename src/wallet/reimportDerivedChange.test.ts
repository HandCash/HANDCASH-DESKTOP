import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
const internalizeAction = vi.fn()
const getBeefForTxidCached = vi.fn()
const withVisibleOnChainBeef = vi.fn(async (work: () => Promise<unknown>) => work())
const withRestoredInternalizeStatus = vi.fn(async (_txid: string, run: () => Promise<unknown>) =>
  run(),
)
const findOutputs = vi.fn()
const findTransactions = vi.fn()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
  },
}))

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    identityKey: '02ab',
    wallet: {
      internalizeAction: (...args: unknown[]) => internalizeAction(...args),
      storage: {
        runAsStorageProvider: async (
          fn: (sp: { findOutputs: typeof findOutputs; findTransactions: typeof findTransactions }) => Promise<unknown>,
        ) => fn({ findOutputs, findTransactions }),
      },
    },
  }),
}))

vi.mock('./beefCache', () => ({
  getBeefForTxidCached: (...args: unknown[]) => getBeefForTxidCached(...args),
}))

vi.mock('./legacyBeef', () => ({
  withVisibleOnChainBeef: (...args: unknown[]) =>
    withVisibleOnChainBeef(...(args as [() => Promise<unknown>])),
}))

vi.mock('./peerIngestHelpers', () => ({
  withRestoredInternalizeStatus: (...args: unknown[]) =>
    withRestoredInternalizeStatus(
      ...(args as [string, () => Promise<unknown>]),
    ),
}))

describe('reimportDerivedChangeOutpoints', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
    internalizeAction.mockReset()
    getBeefForTxidCached.mockReset()
    findOutputs.mockReset()
    findTransactions.mockReset()
    findOutputs.mockResolvedValue([])
    findTransactions.mockResolvedValue([])
    internalizeAction.mockResolvedValue({ accepted: true })
    getBeefForTxidCached.mockResolvedValue({
      toBinaryAtomic: () => [1, 2, 3],
    })
  })

  it('internalizes missing outputs when remittance echo exists', async () => {
    const { rememberDerivedChange } = await import('./derivedChangeEcho')
    const { reimportDerivedChangeOutpoints } = await import('./reimportDerivedChange')
    const txid = 'dd'.repeat(32)
    rememberDerivedChange([
      {
        txid,
        vout: 4,
        satoshis: 1000,
        derivationPrefix: 'pre==',
        derivationSuffix: 'suf==',
      },
    ])

    const result = await reimportDerivedChangeOutpoints([`${txid}_4`])
    expect(result).toEqual({ imported: 1, skipped: 0, failed: 0 })
    expect(internalizeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Reimport derived change',
        outputs: [
          expect.objectContaining({
            outputIndex: 4,
            protocol: 'wallet payment',
            paymentRemittance: expect.objectContaining({
              derivationPrefix: 'pre==',
              derivationSuffix: 'suf==',
            }),
          }),
        ],
      }),
    )
  })

  it('skips live coins that have no remittance echo', async () => {
    const { reimportDerivedChangeOutpoints } = await import('./reimportDerivedChange')
    const txid = 'ee'.repeat(32)
    const result = await reimportDerivedChangeOutpoints([`${txid}.2`])
    expect(result.imported).toBe(0)
    expect(result.skipped).toBe(1)
    expect(internalizeAction).not.toHaveBeenCalled()
  })
})
