import { beforeEach, describe, expect, it, vi } from 'vitest'

const listOutputs = vi.fn()
const listActions = vi.fn()
const balance = vi.fn()

vi.mock('./session', () => ({
  getActiveWallet: () => ({
    wallet: { listOutputs, listActions, balance },
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

  it('still looks empty when only chain-scanned 1sat / bsv21 / 1sat-ft dust is present', async () => {
    balance.mockResolvedValue(0)
    listOutputs.mockImplementation(async (args: { basket?: string }) => {
      if (args.basket === '1sat') return { totalOutputs: 36, outputs: [{}] }
      if (args.basket === 'bsv21') return { totalOutputs: 3, outputs: [{}, {}, {}] }
      if (args.basket === '1sat-ft') return { totalOutputs: 5, outputs: [{}, {}, {}, {}, {}] }
      return { totalOutputs: 0, outputs: [] }
    })
    listActions.mockResolvedValue({ totalActions: 0, actions: [] })
    const { inspectLocalToolboxState } = await import('./layers')
    const state = await inspectLocalToolboxState()
    expect(state.oneSatOutputCount).toBe(36)
    expect(state.bsv21OutputCount).toBe(3)
    expect(state.colourOutputCount).toBe(5)
    expect(state.looksEmpty).toBe(true)
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
