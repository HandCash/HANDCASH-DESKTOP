import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  active: null as unknown,
  probe: vi.fn(),
  proven: vi.fn(),
  hide: vi.fn(),
  bump: vi.fn(),
  blocked: new Set<string>(),
}))

vi.mock('./pinnedWallet', () => ({ pinnedActiveWallet: () => mocks.active }))
vi.mock('./createActionInputFate', () => ({ probeOutpointSpends: mocks.probe }))
vi.mock('./staleOutputRelease', () => ({
  forgetPromotedLocalChange: vi.fn(),
  hideSpentOutpoints: mocks.hide,
  outpointProvenUnspent: mocks.proven,
}))
vi.mock('./utxoLockManager', () => ({
  getUtxoLock: () => null,
  isUtxoBlockedFromRestore: (op: string) => mocks.blocked.has(op),
}))
vi.mock('./session', () => ({ bumpBalanceAfterHeal: mocks.bump }))
vi.mock('./yieldToUi', () => ({ yieldToUi: async () => {} }))

const { reconcileWrittenOffCoins, resetWrittenOffReconcileForTests } = await import(
  './writtenOffCoinReconcile'
)

const script = '76a914000000000000000000000000000000000000000088ac'
const tx = (n: number) => n.toString(16).padStart(2, '0').repeat(32)
const SPENDER = 'd65f31d0'.repeat(8)

type Row = Record<string, unknown>

function walletWith(outputs: Row[], txs: Row[]) {
  const rows = new Map(outputs.map((o) => [o.outputId as number, { ...o }]))
  const updateOutput = vi.fn(async (id: number, patch: Row) => {
    Object.assign(rows.get(id)!, patch)
  })
  const sp = {
    findOutputBaskets: async () => [{ basketId: 1 }],
    findTransactions: async () => txs,
    findOutputs: async (args: { partial: Row }) => {
      if (args.partial.outputId != null) return [rows.get(args.partial.outputId as number)].filter(Boolean)
      return [...rows.values()].filter((r) => r.spendable === false)
    },
    updateOutput,
  }
  mocks.active = {
    identityKey: '03'.padEnd(66, 'a'),
    chain: 'main',
    wallet: {
      storage: {
        getAuth: async () => ({ userId: 1 }),
        runAsStorageProvider: async (fn: (s: typeof sp) => unknown) => fn(sp),
      },
    },
  }
  return { rows, updateOutput }
}

describe('reconcileWrittenOffCoins', () => {
  beforeEach(() => {
    resetWrittenOffReconcileForTests()
    mocks.probe.mockReset()
    mocks.proven.mockReset()
    mocks.hide.mockReset().mockResolvedValue(0)
    mocks.bump.mockReset()
    mocks.blocked.clear()
  })

  it('restores a proven-unspent coin and hides change spent outside the wallet', async () => {
    const { rows } = walletWith(
      [
        { outputId: 1, transactionId: 10, txid: tx(1), vout: 0, satoshis: 95_018, spendable: false, lockingScript: script },
        { outputId: 2, transactionId: 20, txid: tx(2), vout: 1, satoshis: 133_712, spendable: false, lockingScript: script },
        { outputId: 3, transactionId: 30, txid: tx(3), vout: 0, satoshis: 500, spendable: false, lockingScript: script },
      ],
      [
        { transactionId: 10, status: 'completed', txid: tx(1) },
        { transactionId: 20, status: 'unproven', txid: tx(2) },
        { transactionId: 30, status: 'failed', txid: tx(3) },
      ],
    )
    mocks.probe.mockResolvedValue(
      new Map([
        [`${tx(1)}.0`, { kind: 'unspent' }],
        [`${tx(2)}.1`, { kind: 'spent', spender: SPENDER }],
      ]),
    )
    mocks.proven.mockResolvedValue(true)

    const result = await reconcileWrittenOffCoins()

    expect(result).toMatchObject({ candidates: 2, restored: 1, restoredSats: 95_018, hidden: 1, hiddenSats: 133_712 })
    expect(rows.get(1)!.spendable).toBe(true)
    expect(rows.get(3)!.spendable).toBe(false)
    expect(mocks.hide).toHaveBeenCalledWith([`${tx(2)}.1`], SPENDER, mocks.active)
    expect(mocks.bump).toHaveBeenCalled()
  })

  it('never restores without the per-coin proof', async () => {
    const { rows } = walletWith(
      [{ outputId: 1, transactionId: 10, txid: tx(1), vout: 0, satoshis: 1_000, spendable: false, lockingScript: script }],
      [{ transactionId: 10, status: 'completed', txid: tx(1) }],
    )
    mocks.probe.mockResolvedValue(new Map([[`${tx(1)}.0`, { kind: 'unspent' }]]))
    mocks.proven.mockResolvedValue(false)

    const result = await reconcileWrittenOffCoins()

    expect(result.restored).toBe(0)
    expect(rows.get(1)!.spendable).toBe(false)
  })

  it('skips coins held by a local spender or the lock overlay without asking the chain', async () => {
    mocks.blocked.add(`${tx(2)}.0`)
    walletWith(
      [
        { outputId: 1, transactionId: 10, txid: tx(1), vout: 0, satoshis: 1_000, spendable: false, spentBy: 99, lockingScript: script },
        { outputId: 2, transactionId: 10, txid: tx(2), vout: 0, satoshis: 1_000, spendable: false, lockingScript: script },
      ],
      [{ transactionId: 10, status: 'completed', txid: tx(1) }],
    )

    const result = await reconcileWrittenOffCoins()

    expect(result.candidates).toBe(0)
    expect(mocks.probe).not.toHaveBeenCalled()
  })

  it('leaves a coin the chain says a local transaction spent', async () => {
    walletWith(
      [{ outputId: 1, transactionId: 10, txid: tx(1), vout: 0, satoshis: 1_000, spendable: false, lockingScript: script }],
      [
        { transactionId: 10, status: 'completed', txid: tx(1) },
        { transactionId: 11, status: 'completed', txid: SPENDER },
      ],
    )
    mocks.probe.mockResolvedValue(new Map([[`${tx(1)}.0`, { kind: 'spent', spender: SPENDER }]]))

    const result = await reconcileWrittenOffCoins()

    expect(result).toMatchObject({ restored: 0, hidden: 0 })
    expect(mocks.hide).not.toHaveBeenCalled()
  })

  it('runs once per window unless forced', async () => {
    walletWith([], [])
    expect((await reconcileWrittenOffCoins()).skipped).toBe(false)
    expect((await reconcileWrittenOffCoins()).skipped).toBe(true)
    expect((await reconcileWrittenOffCoins({ force: true })).skipped).toBe(false)
  })
})
