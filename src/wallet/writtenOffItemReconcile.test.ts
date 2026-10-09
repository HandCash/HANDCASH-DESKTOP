import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./sentItemGuard', () => ({
  isItemSent: vi.fn(() => false),
  isItemAbandoned: vi.fn(() => false),
}))
vi.mock('./utxoLockManager', () => ({
  getUtxoLock: vi.fn(() => null),
  isUtxoBlockedFromRestore: vi.fn(() => false),
}))
vi.mock('./utxoLifecycle', () => ({ isQuarantined: vi.fn(() => false) }))
vi.mock('./yieldToUi', () => ({ yieldToUi: vi.fn(async () => {}) }))
vi.mock('./storageLockTrace', () => ({
  withStorageLockLabel: <T>(_label: string, fn: () => Promise<T>) => fn(),
}))
vi.mock('./staleOutputRelease', () => ({
  restoreOnChainLocalTx: vi.fn(async () => true),
  pinBroadcastLocalTx: vi.fn(async () => true),
}))
vi.mock('./collectables', () => ({ requestCollectablesRelist: vi.fn() }))

import { reconcileWrittenOffItems } from './writtenOffItemReconcile'
import { isItemSent } from './sentItemGuard'
import { pinBroadcastLocalTx, restoreOnChainLocalTx } from './staleOutputRelease'
import { requestCollectablesRelist } from './collectables'
import type { ActiveWallet } from './session'
import type { LegacyUtxo } from './legacyScan'

const txid = (n: number) => n.toString(16).padStart(64, '0')

type Row = {
  outputId: number
  transactionId: number
  basketId: number
  spendable: boolean
  spentBy: number | null
  txid: string
  vout: number
}

function fakeWallet(rows: Row[], txs: Array<{ transactionId: number; status: string; txid: string }>) {
  const updates: number[] = []
  const sp = {
    findOutputBaskets: async () => [{ basketId: 7 }],
    findOutputs: async (args: { partial: Partial<Row>; paged?: { limit: number; offset: number } }) => {
      const p = args.partial
      const hit = rows.filter(
        (r) =>
          (p.outputId == null || r.outputId === p.outputId) &&
          (p.basketId == null || r.basketId === p.basketId) &&
          (p.spendable == null || r.spendable === p.spendable),
      )
      return args.paged ? hit.slice(args.paged.offset, args.paged.offset + args.paged.limit) : hit
    },
    findTransactions: async (args: { partial: { transactionId: number } }) =>
      txs.filter((t) => t.transactionId === args.partial.transactionId),
    updateOutput: async (id: number, patch: { spendable?: boolean }) => {
      updates.push(id)
      const row = rows.find((r) => r.outputId === id)
      if (row && patch.spendable != null) row.spendable = patch.spendable
    },
  }
  const active = {
    wallet: {
      storage: {
        getAuth: async () => ({ userId: 1 }),
        runAsStorageProvider: <T,>(fn: (provider: typeof sp) => Promise<T>) => fn(sp),
      },
    },
  } as unknown as ActiveWallet
  return { active, updates }
}

const tip = (n: number, vout = 0): LegacyUtxo =>
  ({ outpoint: `${txid(n)}.${vout}`, satoshis: 1 }) as LegacyUtxo

const row = (outputId: number, transactionId: number, n: number, extra: Partial<Row> = {}): Row => ({
  outputId,
  transactionId,
  basketId: 7,
  spendable: false,
  spentBy: null,
  txid: txid(n),
  vout: 0,
  ...extra,
})

describe('reconcileWrittenOffItems', () => {
  beforeEach(() => vi.clearAllMocks())

  it('restores a hidden item whose creator landed, and leaves listed items alone', async () => {
    const { active, updates } = fakeWallet(
      [row(1, 10, 1), row(2, 20, 2, { spendable: true })],
      [{ transactionId: 10, status: 'completed', txid: txid(1) }],
    )
    const result = await reconcileWrittenOffItems({
      active,
      tips: [tip(1), tip(2)],
      basketSpendable: new Set([`${txid(2)}.0`]),
    })
    expect(result).toMatchObject({ absent: 1, rows: 1, restored: 1, restoredOutpoints: [`${txid(1)}.0`] })
    expect(updates).toEqual([1])
    expect(requestCollectablesRelist).toHaveBeenCalledOnce()
  })

  it('revives a failed creator once for every item it made, and pins an app-held one', async () => {
    const { active } = fakeWallet(
      [row(1, 10, 1), row(2, 10, 1, { vout: 1 }), row(3, 30, 3)],
      [
        { transactionId: 10, status: 'failed', txid: txid(1) },
        { transactionId: 30, status: 'nosend', txid: txid(3) },
      ],
    )
    const result = await reconcileWrittenOffItems({
      active,
      tips: [tip(1), tip(1, 1), tip(3)],
      basketSpendable: new Set(),
    })
    expect(restoreOnChainLocalTx).toHaveBeenCalledTimes(1)
    expect(restoreOnChainLocalTx).toHaveBeenCalledWith(txid(1))
    expect(pinBroadcastLocalTx).toHaveBeenCalledWith(txid(3))
    expect(result).toMatchObject({ revived: 1, pinned: 1, restored: 3 })
  })

  it('counts a row the creator revival already freed as restored without rewriting it', async () => {
    const rows = [row(1, 10, 1)]
    const { active, updates } = fakeWallet(rows, [{ transactionId: 10, status: 'failed', txid: txid(1) }])
    vi.mocked(restoreOnChainLocalTx).mockImplementationOnce(async () => {
      rows[0].spendable = true
      return true
    })
    const result = await reconcileWrittenOffItems({ active, tips: [tip(1)], basketSpendable: new Set() })
    expect(result.restoredOutpoints).toEqual([`${txid(1)}.0`])
    expect(updates).toEqual([])
  })

  it('keeps items sent on purpose, spent locally, or whose creator is refused', async () => {
    vi.mocked(isItemSent).mockImplementation((op) => op === `${txid(1)}.0`)
    vi.mocked(restoreOnChainLocalTx).mockResolvedValueOnce(false)
    const { active, updates } = fakeWallet(
      [row(1, 10, 1), row(2, 10, 2, { spentBy: 99 }), row(3, 30, 3)],
      [
        { transactionId: 10, status: 'completed', txid: txid(1) },
        { transactionId: 30, status: 'failed', txid: txid(3) },
      ],
    )
    const result = await reconcileWrittenOffItems({
      active,
      tips: [tip(1), tip(2), tip(3)],
      basketSpendable: new Set(),
    })
    expect(result.restored).toBe(0)
    expect(result.kept).toEqual({ leftOnPurpose: 1, spentLocally: 1, creatorRefused: 1 })
    expect(updates).toEqual([])
    expect(requestCollectablesRelist).not.toHaveBeenCalled()
    vi.mocked(isItemSent).mockReset().mockReturnValue(false)
  })

  it('stops before touching storage when a send is waiting', async () => {
    const { active, updates } = fakeWallet([row(1, 10, 1)], [{ transactionId: 10, status: 'completed', txid: txid(1) }])
    const result = await reconcileWrittenOffItems({
      active,
      tips: [tip(1)],
      basketSpendable: new Set(),
      shouldStop: () => true,
    })
    expect(result).toMatchObject({ stopped: true, rows: 0, restored: 0 })
    expect(updates).toEqual([])
  })
})
