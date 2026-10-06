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
    return true
  },
}))

const probeOutpointSpends = vi.fn()

function makeWallet(identityKey = '02ab') {
  return {
    identityKey,
    accountIndex: 0,
    chain: 'main' as const,
    wallet: {
      internalizeAction: (...args: unknown[]) => internalizeAction(...args),
      storage: {
        runAsStorageProvider: async (
          fn: (sp: { findOutputs: typeof findOutputs; findTransactions: typeof findTransactions }) => Promise<unknown>,
        ) => fn({ findOutputs, findTransactions }),
      },
    },
  }
}
const current: { wallet: ReturnType<typeof makeWallet> | null } = { wallet: makeWallet() }

vi.mock('./session', () => ({
  getActiveWallet: () => current.wallet,
}))
vi.mock('./walletRuntime', () => ({
  getWalletRuntime: () => (current.wallet ? { instance: current.wallet } : null),
}))

vi.mock('./createActionInputFate', () => ({
  probeOutpointSpends: (...args: unknown[]) => probeOutpointSpends(...args),
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
        description: 'Recover from custody journal',
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

describe('derivation echo across a wipe or older restore', () => {
  const live = 'aa'.repeat(32)
  const spent = 'bb'.repeat(32)
  const held = 'cc'.repeat(32)

  beforeEach(() => {
    store.clear()
    vi.resetModules()
    current.wallet = makeWallet()
    internalizeAction.mockReset().mockResolvedValue({ accepted: true })
    getBeefForTxidCached.mockReset().mockResolvedValue({ toBinaryAtomic: () => [1, 2, 3] })
    findOutputs.mockReset().mockResolvedValue([])
    findTransactions.mockReset().mockResolvedValue([])
    probeOutpointSpends.mockReset()
  })

  it('echoes every derived row the store holds, spent or not', async () => {
    findOutputs.mockImplementation(async (args: { partial: { spendable: boolean } }) =>
      args.partial.spendable
        ? [{ txid: live, vout: 1, satoshis: 900, derivationPrefix: 'p1', derivationSuffix: 's1' }]
        : [
            { txid: spent, vout: 0, satoshis: 50, derivationPrefix: 'p2', derivationSuffix: 's2' },
            { txid: held, vout: 0, satoshis: 1 },
          ],
    )
    const { echoAllDerivedOutputs } = await import('./reimportDerivedChange')
    const { listDerivedChangeEcho } = await import('./derivedChangeEcho')

    expect(await echoAllDerivedOutputs(current.wallet!)).toBe(2)
    expect(listDerivedChangeEcho().map((e) => e.txid).sort()).toEqual([live, spent])
  })

  it('reimports live echoes, forgets spent ones, and leaves held rows alone', async () => {
    const { rememberDerivedChange, listDerivedChangeEcho } = await import('./derivedChangeEcho')
    rememberDerivedChange([
      { txid: live, vout: 1, satoshis: 900, derivationPrefix: 'p1', derivationSuffix: 's1' },
      { txid: spent, vout: 0, satoshis: 50, derivationPrefix: 'p2', derivationSuffix: 's2' },
      { txid: held, vout: 2, satoshis: 70, derivationPrefix: 'p3', derivationSuffix: 's3' },
    ])
    findOutputs.mockImplementation(async (args: { partial: { spendable?: boolean; txid?: string } }) =>
      args.partial.spendable === true ? [{ txid: held, vout: 2, satoshis: 70 }] : [],
    )
    probeOutpointSpends.mockResolvedValue(
      new Map([
        [`${live}.1`, { kind: 'unspent' }],
        [`${spent}.0`, { kind: 'spent', spender: 'ff'.repeat(32) }],
      ]),
    )
    const { recoverEchoedChange } = await import('./reimportDerivedChange')

    const result = await recoverEchoedChange(current.wallet)

    expect(probeOutpointSpends.mock.calls[0]![0]).toEqual([`${live}.1`, `${spent}.0`])
    expect(result).toMatchObject({ checked: 2, imported: 1, spent: 1, unknown: 0 })
    expect(internalizeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        outputs: [
          expect.objectContaining({
            outputIndex: 1,
            paymentRemittance: expect.objectContaining({ derivationPrefix: 'p1', derivationSuffix: 's1' }),
          }),
        ],
      }),
    )
    expect(listDerivedChangeEcho().some((e) => e.txid === spent)).toBe(false)
  })

  it('keeps an echo the explorer did not answer for the next pass', async () => {
    const { rememberDerivedChange, listDerivedChangeEcho } = await import('./derivedChangeEcho')
    rememberDerivedChange([
      { txid: live, vout: 1, satoshis: 900, derivationPrefix: 'p1', derivationSuffix: 's1' },
    ])
    probeOutpointSpends.mockResolvedValue(new Map([[`${live}.1`, { kind: 'unknown' }]]))
    const { recoverEchoedChange } = await import('./reimportDerivedChange')

    expect(await recoverEchoedChange(current.wallet)).toMatchObject({ unknown: 1, imported: 0 })
    expect(listDerivedChangeEcho()).toHaveLength(1)
    expect(internalizeAction).not.toHaveBeenCalled()
  })

  it('imports nothing into the next account when the switch lands mid-probe', async () => {
    const { rememberDerivedChange } = await import('./derivedChangeEcho')
    rememberDerivedChange([
      { txid: live, vout: 1, satoshis: 900, derivationPrefix: 'p1', derivationSuffix: 's1' },
    ])
    const before = current.wallet
    probeOutpointSpends.mockImplementation(async () => {
      current.wallet = makeWallet('03cd')
      return new Map([[`${live}.1`, { kind: 'unspent' }]])
    })
    const { recoverEchoedChange } = await import('./reimportDerivedChange')

    expect(await recoverEchoedChange(before)).toMatchObject({ imported: 0 })
    expect(internalizeAction).not.toHaveBeenCalled()
  })
})
