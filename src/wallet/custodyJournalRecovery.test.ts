import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

const internalizeAction = vi.fn()
const findOutputs = vi.fn()
const probeOutpointSpends = vi.fn()
const active = {
  identityKey: '02' + 'd4'.repeat(32),
  accountIndex: 0,
  chain: 'main' as const,
  wallet: {
    internalizeAction: (...args: unknown[]) => internalizeAction(...args),
    storage: { runAsStorageProvider: async (fn: (sp: unknown) => Promise<unknown>) => fn({ findOutputs }) },
  },
}
vi.mock('./walletRuntime', () => ({ getWalletRuntime: () => ({ instance: active }) }))
vi.mock('./createActionInputFate', () => ({
  probeOutpointSpends: (...args: unknown[]) => probeOutpointSpends(...args),
}))
vi.mock('./beefCache', () => ({ getBeefForTxidCached: async () => ({ toBinaryAtomic: () => [1, 2, 3] }) }))
vi.mock('./legacyBeef', () => ({ withVisibleOnChainBeef: (work: () => Promise<unknown>) => work() }))
vi.mock('./peerIngestHelpers', () => ({
  withRestoredInternalizeStatus: (_txid: string, run: () => Promise<unknown>) => run(),
}))
vi.mock('./utxoLockManager', () => ({ creditUtxo: vi.fn(), releaseConsumedUtxo: vi.fn() }))
vi.mock('./derivedChangeEcho', () => ({ listDerivedChangeEcho: () => [], forgetDerivedChange: () => 0 }))

const item = 'e1'.repeat(32)
const gone = 'e2'.repeat(32)
const unsure = 'e3'.repeat(32)

describe('custody journal recovery', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
    internalizeAction.mockReset().mockResolvedValue({ accepted: true })
    findOutputs.mockReset().mockResolvedValue([])
    probeOutpointSpends.mockReset()
  })

  it('re-inserts a lost basket output, journals a chain spend, and backs off an unanswered probe', async () => {
    const { appendCustody, unspentCustodyOutputs } = await import('./custodyJournal')
    appendCustody(active, [
      { k: 'out', op: `${item}.1`, sats: 1, r: { p: 'basket insertion', basket: '1sat', ci: '{"origin":"o_0"}', tags: ['origin:o_0'] } },
      { k: 'out', op: `${gone}.0`, sats: 700, r: { p: 'wallet payment', prefix: 'p', suffix: 's' } },
      { k: 'out', op: `${unsure}.0`, sats: 300, r: { p: 'wallet payment', prefix: 'q', suffix: 's' } },
    ])
    probeOutpointSpends.mockResolvedValue(
      new Map([
        [`${item}.1`, { kind: 'unspent' }],
        [`${gone}.0`, { kind: 'spent', spender: 'ff'.repeat(32) }],
        [`${unsure}.0`, { kind: 'unknown' }],
      ]),
    )
    const { recoverFromCustodyJournal } = await import('./custodyJournalRecovery')

    expect(await recoverFromCustodyJournal(active as never)).toMatchObject({
      checked: 3, live: 1, imported: 1, spent: 1, unknown: 1,
    })
    expect(internalizeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        outputs: [
          {
            outputIndex: 1,
            protocol: 'basket insertion',
            insertionRemittance: { basket: '1sat', customInstructions: '{"origin":"o_0"}', tags: ['origin:o_0'] },
          },
        ],
      }),
    )
    expect(unspentCustodyOutputs(active).map((o) => o.op).sort()).toEqual([`${item}.1`, `${unsure}.0`])

    // The held item is no longer a candidate; the unanswered one waits out its backoff.
    findOutputs.mockImplementation(async (args: { partial: { spendable: boolean } }) =>
      args.partial.spendable ? [{ txid: item, vout: 1 }] : [],
    )
    expect(await recoverFromCustodyJournal(active as never)).toMatchObject({ checked: 0 })
  })

  it('never internalizes over a row the toolbox already holds', async () => {
    const { appendCustody } = await import('./custodyJournal')
    appendCustody(active, [{ k: 'out', op: `${gone}.0`, sats: 700, r: { p: 'wallet payment', prefix: 'p', suffix: 's' } }])
    findOutputs.mockImplementation(async (args: { partial: { spendable: boolean } }) =>
      args.partial.spendable ? [] : [{ txid: gone, vout: 0 }],
    )
    const { reimportJournaledOutpoints } = await import('./custodyJournalRecovery')
    expect(await reimportJournaledOutpoints(active as never, [`${gone}_0`])).toEqual({ imported: 0, skipped: 0, failed: 0 })
    expect(internalizeAction).not.toHaveBeenCalled()
  })
})
