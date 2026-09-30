import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetClearedOutpointsForTests } from './createActionInputFate'
import { sweepDeadCoins } from './deadCoinSweep'
import type { WalletRuntime } from './walletRuntime'

const DEAD = 'd1'.repeat(32)
const LIVE = 'a1'.repeat(32)
const FLAKY = 'f1'.repeat(32)
const UNMINED = 'c1'.repeat(32)
const ITEM = 'e1'.repeat(32)
const SPENDER = 'bb'.repeat(32)

const hides: Array<{ outpoints: string[]; spender: string }> = []
const bumpBalanceAfterHeal = vi.fn()
let spendBusy = false

const outputs = [
  { txid: DEAD, vout: 0, satoshis: 500, change: true, transactionId: 1 },
  { txid: LIVE, vout: 1, satoshis: 800, change: true, transactionId: 2 },
  { txid: FLAKY, vout: 0, satoshis: 700, change: true, transactionId: 3 },
  { txid: UNMINED, vout: 0, satoshis: 900, change: true, transactionId: 9 },
  { txid: ITEM, vout: 0, satoshis: 1, change: true, transactionId: 4, basket: '1sat' },
]

const storage = {
  runAsStorageProvider: async <T>(fn: (sp: unknown) => Promise<T>) =>
    fn({
      findTransactions: async () => [{ transactionId: 9 }],
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

vi.mock('./staleOutputRelease', () => ({
  hideSpentOutpoints: async (outpoints: string[], spender: string) => {
    hides.push({ outpoints, spender })
    return outpoints.length
  },
}))

describe('sweepDeadCoins', () => {
  const fetch = vi.fn(async (url: string) => {
    if (url.includes(DEAD)) {
      return { ok: true, status: 200, json: async () => ({ txid: SPENDER, status: 'confirmed' }) }
    }
    if (url.includes(FLAKY)) return { ok: false, status: 429, json: async () => ({}) }
    return { ok: false, status: 404, json: async () => ({}) }
  })

  beforeEach(() => {
    hides.length = 0
    spendBusy = false
    current = true
    bumpBalanceAfterHeal.mockReset()
    fetch.mockClear()
    vi.stubGlobal('fetch', fetch)
  })

  afterEach(() => {
    resetClearedOutpointsForTests()
    vi.unstubAllGlobals()
  })

  it('hides only coins with a named confirmed spender', async () => {
    await expect(sweepDeadCoins(runtime)).resolves.toEqual({
      ran: true,
      checked: 3,
      hidden: 1,
      unknown: 1,
    })
    expect(hides).toEqual([{ outpoints: [`${DEAD}.0`], spender: SPENDER }])
    expect(bumpBalanceAfterHeal).toHaveBeenCalledOnce()
  })

  it('never asks about change of an unmined local tx or an asset basket', async () => {
    await sweepDeadCoins(runtime)
    const asked = fetch.mock.calls.map(([url]) => String(url))
    expect(asked.some((url) => url.includes(UNMINED))).toBe(false)
    expect(asked.some((url) => url.includes(ITEM))).toBe(false)
  })

  it('does not re-ask coins cleared minutes ago', async () => {
    await sweepDeadCoins(runtime)
    fetch.mockClear()
    await sweepDeadCoins(runtime)
    const asked = fetch.mock.calls.map(([url]) => String(url))
    expect(asked.some((url) => url.includes(LIVE))).toBe(false)
  })

  it('does nothing for a runtime that was locked or switched away', async () => {
    current = false
    await expect(sweepDeadCoins(runtime)).resolves.toEqual({ ran: false, reason: 'locked' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
