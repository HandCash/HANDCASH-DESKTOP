import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FungibleToken } from './types'

const store = new Map<string, string>()

/** Basket read behaviour, swapped per test. */
const liveRead = { run: async (): Promise<unknown[]> => [] }
/** Unbounded await inside the list, used to simulate a stalled read. */
const restoreAsset = { run: async (): Promise<boolean> => false }

vi.mock('../durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
  durableRemoveItem: (key: string) => {
    store.delete(key)
  },
}))

vi.mock('../session', () => ({
  getActiveWallet: () => ({
    address: '1Test',
    chain: 'main',
    wallet: { listOutputs: async () => ({ outputs: [] }) },
  }),
}))

vi.mock('../appActivity', () => ({ exportAllActivity: () => [] }))

vi.mock('../walletCoordinator', () => ({
  getSpendPriorityDepth: () => 0,
  getWalletCoordinatorSnapshot: () => ({ chainIngest: 'idle', spend: 'idle' }),
  shouldYieldChainIngestToSpend: () => false,
}))

vi.mock('./listTips', () => ({
  listBsv21BinaryTokens: () => liveRead.run(),
}))

vi.mock('../staleOutputRelease', () => ({
  restoreUnspentAssetOutpoint: () => restoreAsset.run(),
}))

vi.mock('../txStore', () => ({ isLocalUnconfirmedTxid: () => false }))

vi.mock('../beefCache', () => ({
  getLocalBeefForTxid: async () => null,
  rememberBeef: () => {},
  rememberBeefBinary: () => {},
}))

vi.mock('../yieldToUi', () => ({ yieldToUi: async () => {} }))

const TOKEN = `${'ab'.repeat(32)}_0`

function card(): FungibleToken {
  return {
    tokenId: TOKEN,
    sym: 'COPE',
    amt: '500',
    dec: 0,
    utxoCount: 1,
    outpoint: `${'cd'.repeat(32)}.0`,
    spendKind: 'plain',
    binarySupply: 'locked',
    encoding: 'brc162',
  }
}

const never = () => new Promise<never>(() => {})

describe('listFungibles coalescing', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
    vi.useFakeTimers()
    liveRead.run = async () => []
    restoreAsset.run = async () => false
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * A basket call parked behind a spend must not be read as "you hold
   * nothing" — and must not hold the caller forever either.
   */
  it('times out a stalled basket read and keeps the cached cards', async () => {
    const { listFungibles, rememberFungibleToken } = await import('./list')
    rememberFungibleToken(card())
    liveRead.run = never

    const pending = listFungibles()
    await vi.advanceTimersByTimeAsync(13_000)

    expect((await pending).map((t) => t.tokenId)).toEqual([TOKEN])
  })

  /**
   * The field case: an account rebind started a read that never settled, so
   * every later caller joined it and the Tokens list stopped tracking the
   * wallet while Collect kept refreshing beside it.
   */
  it('starts a fresh read instead of joining one that never settled', async () => {
    const { listFungibles, rememberFungibleToken } = await import('./list')
    rememberFungibleToken(card())
    restoreAsset.run = never

    const stalled = listFungibles()
    await vi.advanceTimersByTimeAsync(21_000)
    restoreAsset.run = async () => false

    const fresh = listFungibles()
    expect(fresh).not.toBe(stalled)
    await vi.advanceTimersByTimeAsync(100)
    expect((await fresh).map((t) => t.tokenId)).toEqual([TOKEN])
  })

  it('joins a read that is still within the deadline', async () => {
    const { listFungibles } = await import('./list')
    liveRead.run = never
    const first = listFungibles()
    expect(listFungibles()).toBe(first)
    await vi.advanceTimersByTimeAsync(13_000)
    await first
  })
})
