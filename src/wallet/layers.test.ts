import { beforeEach, describe, expect, it, vi } from 'vitest'

const listOutputs = vi.fn()
const listActions = vi.fn()
const balance = vi.fn()
let storage: unknown

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    wallet: { listOutputs, listActions, balance, storage },
  }),
  fetchBalanceSats: async () => {
    const sats = await balance()
    return Number.isFinite(sats) ? Math.max(0, Math.trunc(sats)) : 0
  },
}))

describe('localToolboxStateLooksEmpty', () => {
  beforeEach(() => {
    vi.resetModules()
    listOutputs.mockReset()
    listActions.mockReset()
    balance.mockReset()
    storage = undefined
  })

  function indexedStorage(rows: { change: number; actions: number }) {
    const calls: Array<[string, unknown]> = []
    storage = {
      getAuth: async () => ({ userId: 7 }),
      runAsStorageProvider: async <T,>(fn: (sp: unknown) => Promise<T>) =>
        fn({
          findOutputBaskets: async (args: unknown) => {
            calls.push(['baskets', args])
            return [{ basketId: 3 }]
          },
          findOutputs: async (args: unknown) => {
            calls.push(['outputs', args])
            return rows.change > 0 ? [{}] : []
          },
          findTransactions: async (args: unknown) => {
            calls.push(['transactions', args])
            return rows.actions > 0 ? [{}] : []
          },
        }),
    }
    return calls
  }

  it('reads one indexed row per question instead of counting through the toolbox', async () => {
    const calls = indexedStorage({ change: 0, actions: 4000 })
    const { localToolboxStateLooksEmpty } = await import('./layers')
    expect(await localToolboxStateLooksEmpty()).toBe(false)
    expect(listOutputs).not.toHaveBeenCalled()
    expect(listActions).not.toHaveBeenCalled()
    expect(balance).not.toHaveBeenCalled()
    expect(calls).toEqual([
      ['baskets', { partial: { userId: 7, name: 'default' } }],
      ['outputs', { partial: { userId: 7, basketId: 3, spendable: true }, noScript: true, paged: { limit: 1 } }],
      ['transactions', expect.objectContaining({ partial: { userId: 7 }, noRawTx: true, paged: { limit: 1 } })],
    ])
  })

  it('stops at a spendable change output', async () => {
    const calls = indexedStorage({ change: 1, actions: 0 })
    const { localToolboxStateLooksEmpty } = await import('./layers')
    expect(await localToolboxStateLooksEmpty()).toBe(false)
    expect(calls.map(([kind]) => kind)).toEqual(['baskets', 'outputs'])
  })

  it('falls back to balance when storage holds no history', async () => {
    indexedStorage({ change: 0, actions: 0 })
    balance.mockResolvedValue(0)
    const { localToolboxStateLooksEmpty } = await import('./layers')
    expect(await localToolboxStateLooksEmpty()).toBe(true)
    expect(listOutputs).not.toHaveBeenCalled()
  })

  it('is empty when balance, outs, and actions are all zero', async () => {
    balance.mockResolvedValue(0)
    listOutputs.mockResolvedValue({ totalOutputs: 0, outputs: [] })
    listActions.mockResolvedValue({ totalActions: 0, actions: [] })
    const { localToolboxStateLooksEmpty } = await import('./layers')
    expect(await localToolboxStateLooksEmpty()).toBe(true)
  })

  it('is not empty when spendable is zero but actions exist (spent P2P history)', async () => {
    balance.mockResolvedValue(0)
    listOutputs.mockResolvedValue({ totalOutputs: 0, outputs: [] })
    listActions.mockResolvedValue({ totalActions: 12, actions: [{}] })
    const { localToolboxStateLooksEmpty } = await import('./layers')
    expect(await localToolboxStateLooksEmpty()).toBe(false)
  })

  it('still looks empty when only chain-scanned 1sat / bsv21 inventory is present', async () => {
    balance.mockResolvedValue(0)
    listOutputs.mockImplementation(async (args: { basket?: string }) => {
      if (args.basket === '1sat') return { totalOutputs: 36, outputs: [{}] }
      if (args.basket === 'bsv21') return { totalOutputs: 3, outputs: [{}, {}, {}] }
      return { totalOutputs: 0, outputs: [] }
    })
    listActions.mockResolvedValue({ totalActions: 0, actions: [] })
    const { inspectLocalToolboxState, localToolboxStateLooksEmpty } = await import('./layers')
    const state = await inspectLocalToolboxState()
    expect(state.looksEmpty).toBe(true)
    expect(await localToolboxStateLooksEmpty()).toBe(true)
    const baskets = listOutputs.mock.calls.map(([args]) => (args as { basket?: string }).basket)
    expect(baskets).not.toContain('1sat')
    expect(baskets).not.toContain('bsv21')
  })

  it('stops at the first change output without reading actions or balance', async () => {
    listOutputs.mockResolvedValue({ totalOutputs: 4, outputs: [{}] })
    const { localToolboxStateLooksEmpty } = await import('./layers')
    expect(await localToolboxStateLooksEmpty()).toBe(false)
    expect(listActions).not.toHaveBeenCalled()
    expect(balance).not.toHaveBeenCalled()
  })

  it('is not empty when default basket outs remain', async () => {
    balance.mockResolvedValue(0)
    listOutputs.mockImplementation(async (args: { basket?: string }) => {
      if (args.basket === 'default') return { totalOutputs: 2, outputs: [{}, {}] }
      return { totalOutputs: 0, outputs: [] }
    })
    listActions.mockResolvedValue({ totalActions: 0, actions: [] })
    const { inspectLocalToolboxState } = await import('./layers')
    const state = await inspectLocalToolboxState()
    expect(state.defaultOutputCount).toBe(2)
    expect(state.looksEmpty).toBe(false)
  })
})

describe('WALLET_FEATURE_MODULES', () => {
  it('names the public surfaces beside layers', async () => {
    const { WALLET_FEATURE_MODULES } = await import('./layers')
    expect(WALLET_FEATURE_MODULES.tokens).toBe('token/index.ts')
    expect(WALLET_FEATURE_MODULES.spendVerdict).toBe('spendVerdict/index.ts')
    expect(WALLET_FEATURE_MODULES.chainProbe).toBe('chainProbe/index.ts')
    expect(WALLET_FEATURE_MODULES.marketOffer).toBe('marketOffer/index.ts')
    expect(WALLET_FEATURE_MODULES.legacyImport).toBe('import/index.ts')
    expect(WALLET_FEATURE_MODULES.uiFeed).toBe('components/uiFeed/index.ts')
  })
})
