import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetClearedOutpointsForTests } from './createActionInputFate'
import {
  adoptSpendersLater,
  resetDeadCoinSweepForTests,
  scheduleUnlockDeadCoinPass,
  sweepDeadCoins,
} from './deadCoinSweep'
import type { WalletRuntime } from './walletRuntime'

const DEAD = 'd1'.repeat(32)
const LIVE = 'a1'.repeat(32)
const FLAKY = 'f1'.repeat(32)
const UNMINED = 'c1'.repeat(32)
const ITEM = 'e1'.repeat(32)
const UNPROVEN = 'c2'.repeat(32)
const SPENDER = 'bb'.repeat(32)
const OLD_SPENDER = 'b2'.repeat(32)

const hides: Array<{ outpoints: string[]; spender: string }> = []
const bumpBalanceAfterHeal = vi.fn()
let spendBusy = false
/** Bulk requests in which FLAKY still goes unanswered. */
let flakyMisses = Infinity
const prefs = new Map<string, string>()
let locks: Array<{ diagnostic?: string; spentBy?: string }> = []

const outputs = [
  { txid: DEAD, vout: 0, satoshis: 500, change: true, transactionId: 1 },
  { txid: LIVE, vout: 1, satoshis: 800, change: true, transactionId: 2 },
  { txid: FLAKY, vout: 0, satoshis: 700, change: true, transactionId: 3 },
  { txid: UNMINED, vout: 0, satoshis: 900, change: true, transactionId: 9 },
  { txid: ITEM, vout: 0, satoshis: 1, change: true, transactionId: 4, basket: '1sat' },
  { txid: UNPROVEN, vout: 2, satoshis: 600, change: true, transactionId: 10 },
]

const storage = {
  runAsStorageProvider: async <T>(fn: (sp: unknown) => Promise<T>) =>
    fn({
      findTransactions: async ({ status }: { status: string[] }) => [
        ...(status.includes('nosend') ? [{ transactionId: 9 }] : []),
        ...(status.includes('unproven') ? [{ transactionId: 10 }] : []),
      ],
      findOutputs: async () => outputs,
    }),
}

let current = true
const runtime = {
  instance: { chain: 'main', identityKey: '02ab', wallet: { storage } },
  runtimeId: 'r1',
} as unknown as WalletRuntime

vi.mock('./session', () => ({
  bumpBalanceAfterHeal: () => bumpBalanceAfterHeal(),
}))

vi.mock('./walletRuntime', () => ({
  getWalletRuntime: () => runtime,
  runtimeIsCurrent: () => current,
}))

vi.mock('./walletCoordinator', () => ({
  shouldYieldChainIngestToSpend: () => spendBusy,
}))

vi.mock('./localTxClosure', () => ({
  LIVE_LOCAL_TX_STATUSES: ['unproven', 'sending'],
}))

vi.mock('./recompose', () => ({ isRecomposeInFlight: () => false }))

vi.mock('./utxoLockManager', () => ({ listUtxoLocks: () => locks }))

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => prefs.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    prefs.set(key, value)
    return true
  },
}))

const adoptConfirmedSpender = vi.fn(async (_txid: string) => 'restored')

vi.mock('./staleOutputRelease', () => ({
  hideSpentOutpoints: async (outpoints: string[], spender: string) => {
    hides.push({ outpoints, spender })
    return outpoints.length
  },
  adoptConfirmedSpender: (txid: string) => adoptConfirmedSpender(txid),
}))

type Utxo = { txid: string; vout: number }

const isExplorer = (url: unknown) => String(url).includes('api.whatsonchain.com')

const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
  if (!isExplorer(url)) return { ok: false, status: 503, json: async () => ({}) }
  const { utxos } = JSON.parse(init?.body ?? '{"utxos":[]}') as { utxos: Utxo[] }
  const flakyAsked = utxos.some((u) => u.txid === FLAKY)
  const flakyAnswers = flakyAsked && flakyMisses <= 0
  if (flakyAsked) flakyMisses -= 1
  return {
    ok: true,
    status: 200,
    json: async () =>
      utxos.map((utxo) => {
        if (utxo.txid === DEAD || (utxo.txid === FLAKY && flakyAnswers)) {
          return { utxo, spentIn: { txid: SPENDER, vin: 0, status: 'confirmed' }, error: '' }
        }
        if (utxo.txid === FLAKY) {
          return { utxo, spentIn: { txid: FLAKY, vin: 0, status: 'Unknown UTXO' }, error: '' }
        }
        return { utxo, error: '' }
      }),
  }
})

const explorerCalls = () => fetch.mock.calls.filter(([url]) => isExplorer(url))

const askedTxids = () =>
  explorerCalls().flatMap(([, init]) =>
    (JSON.parse(init?.body ?? '{"utxos":[]}') as { utxos: Utxo[] }).utxos.map((u) => u.txid),
  )

/** Runs `task` with fake timers far enough for every sweep retry. */
async function drained<T>(task: () => Promise<T>): Promise<T> {
  const pending = task()
  await vi.advanceTimersByTimeAsync(60_000)
  return pending
}

describe('sweepDeadCoins', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    hides.length = 0
    spendBusy = false
    current = true
    flakyMisses = Infinity
    prefs.clear()
    locks = []
    bumpBalanceAfterHeal.mockReset()
    adoptConfirmedSpender.mockClear()
    resetDeadCoinSweepForTests()
    fetch.mockClear()
    vi.stubGlobal('fetch', fetch)
  })

  afterEach(() => {
    resetClearedOutpointsForTests()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('hides only coins with a named confirmed spender, asking in one request', async () => {
    await expect(drained(() => sweepDeadCoins(runtime))).resolves.toEqual({
      ran: true,
      checked: 4,
      hidden: 1,
      unknown: 1,
    })
    expect(hides).toEqual([{ outpoints: [`${DEAD}.0`], spender: SPENDER }])
    expect(explorerCalls()[0]?.[0]).toMatch(/\/utxos\/spent$/)
  })

  it('asks again about coins the explorer left unanswered and hides them when named', async () => {
    flakyMisses = 1
    await expect(drained(() => sweepDeadCoins(runtime))).resolves.toEqual({
      ran: true,
      checked: 4,
      hidden: 2,
      unknown: 0,
    })
    expect(hides).toEqual([
      { outpoints: [`${DEAD}.0`], spender: SPENDER },
      { outpoints: [`${FLAKY}.0`], spender: SPENDER },
    ])
  })

  it('gives up on an unanswered coin after two retries', async () => {
    await drained(() => sweepDeadCoins(runtime))
    expect(askedTxids().filter((t) => t === FLAKY)).toHaveLength(3)
  })

  it('adopts the spender of every coin it hides, so stranded change comes back', async () => {
    flakyMisses = 0
    await drained(() => sweepDeadCoins(runtime))
    expect(adoptConfirmedSpender).toHaveBeenCalledWith(SPENDER)
    expect(adoptConfirmedSpender).toHaveBeenCalledOnce()
    expect(bumpBalanceAfterHeal).toHaveBeenCalledTimes(2)
  })

  it('adopts queued spenders once each and stops when the account changes', async () => {
    adoptSpendersLater(runtime, [SPENDER, SPENDER, 'not-a-txid'])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(adoptConfirmedSpender).toHaveBeenCalledOnce()

    current = false
    adoptSpendersLater(runtime, [DEAD])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(adoptConfirmedSpender).toHaveBeenCalledOnce()
  })

  it('never asks about change of a never-broadcast local tx or an asset basket', async () => {
    await drained(() => sweepDeadCoins(runtime))
    expect(askedTxids()).not.toContain(UNMINED)
    expect(askedTxids()).not.toContain(ITEM)
  })

  it('asks about change of a broadcast tx whose proof was never stored', async () => {
    await drained(() => sweepDeadCoins(runtime))
    expect(askedTxids()).toContain(UNPROVEN)
  })

  it('does not re-ask coins cleared minutes ago', async () => {
    await drained(() => sweepDeadCoins(runtime))
    fetch.mockClear()
    await drained(() => sweepDeadCoins(runtime))
    expect(askedTxids()).not.toContain(LIVE)
  })

  it('does nothing for a runtime that was locked or switched away', async () => {
    current = false
    await expect(sweepDeadCoins(runtime)).resolves.toEqual({ ran: false, reason: 'locked' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('sweeps at unlock, then replays old spenders once across launches', async () => {
    flakyMisses = 0
    locks = [{ diagnostic: `spent-by:${OLD_SPENDER.slice(0, 12)}`, spentBy: OLD_SPENDER }]
    scheduleUnlockDeadCoinPass(runtime)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hides.flatMap((h) => h.outpoints)).toEqual([`${DEAD}.0`, `${FLAKY}.0`])
    expect(adoptConfirmedSpender.mock.calls.map(([id]) => id).sort()).toEqual(
      [OLD_SPENDER, SPENDER].sort(),
    )

    adoptConfirmedSpender.mockClear()
    resetClearedOutpointsForTests()
    scheduleUnlockDeadCoinPass({ ...runtime, runtimeId: 'r2' } as WalletRuntime)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(adoptConfirmedSpender).not.toHaveBeenCalledWith(OLD_SPENDER)
  })
})
