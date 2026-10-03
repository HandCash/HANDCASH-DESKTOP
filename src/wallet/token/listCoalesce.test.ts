import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FungibleToken } from './types'

const store = new Map<string, string>()

/** Basket read behaviour, swapped per test. */
const liveRead = { run: async (): Promise<unknown[]> => [] }
let liveReads = 0
/** Whether every wallet region is idle, swapped per test. */
const regions = { idle: () => true, generation: 0 }
/** Local transaction read for our own unconfirmed tips — uncancellable. */
const localTx = { run: async (): Promise<null> => null, unconfirmed: false }
const reported: Array<{ listed: Set<string>; leftBasket?: Array<{ outpoint: string }> }> = []

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
  walletRegionsIdle: () => regions.idle(),
  walletRegionsGeneration: () => regions.generation,
  walletRegionsIdleSince: (generation: number) =>
    regions.generation === generation && regions.idle(),
  waitForWalletRegionsIdle: async () => false,
}))

vi.mock('./listTips', () => ({
  listHeldFungibleTokens: () => {
    liveReads += 1
    return liveRead.run()
  },
}))

vi.mock('../holdingsReconcile', () => ({
  reportHoldings: (report: (typeof reported)[number]) => {
    reported.push(report)
  },
}))

vi.mock('../staleOutputRelease', () => ({
  restoreUnspentAssetOutpoint: async () => false,
}))

vi.mock('../txStore', () => ({ isLocalUnconfirmedTxid: () => localTx.unconfirmed }))

vi.mock('../beefCache', () => ({
  getLocalBeefForTxid: async () => null,
  getLocalTxForTxid: () => localTx.run(),
  rememberBeef: () => {},
  rememberBeefBinary: () => {},
}))

vi.mock('../yieldToUi', () => ({
  yieldToUi: async () => {},
  uiBudgetExpired: () => false,
}))

const TOKEN = `${'ab'.repeat(32)}_0`
const OTHER = `${'dd'.repeat(32)}_0`

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
    liveReads = 0
    regions.idle = () => true
    regions.generation = 0
    reported.length = 0
    localTx.run = async () => null
    localTx.unconfirmed = false
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
    expect(reported).toEqual([])
  })

  /**
   * Toolbox work cannot be cancelled. Timing out releases the UI to cache, but
   * a later caller must not stack another crypto/IDB walk behind the first.
   */
  it('serves cache without replacing wallet work that never settled', async () => {
    const { listFungibles, rememberFungibleToken } = await import('./list')
    rememberFungibleToken(card())
    liveRead.run = async () => []
    localTx.unconfirmed = true
    localTx.run = never

    const stalled = listFungibles()
    await vi.advanceTimersByTimeAsync(21_000)
    expect((await stalled).map((t) => t.tokenId)).toEqual([TOKEN])

    const fresh = listFungibles()
    expect((await fresh).map((t) => t.tokenId)).toEqual([TOKEN])
    expect(liveReads).toBe(1)
  })

  it('a failed read publishes nothing and files nothing', async () => {
    const { listFungibles, rememberFungibleToken } = await import('./list')
    rememberFungibleToken({ ...card(), seenAt: 1 })
    liveRead.run = async () => {
      throw new Error('basket bsv21 listed 1000 of 1400 row(s)')
    }
    expect((await listFungibles()).map((t) => t.tokenId)).toEqual([TOKEN])
    expect(reported).toEqual([])
  })

  it('drops an aged card the basket no longer lists and files its tip', async () => {
    const { listFungibles, rememberFungibleToken } = await import('./list')
    rememberFungibleToken({ ...card(), seenAt: 1 })

    expect(await listFungibles()).toEqual([])
    expect(reported).toHaveLength(1)
    expect(reported[0]!.leftBasket?.map((l) => l.outpoint)).toEqual([`${'cd'.repeat(32)}.0`])
  })

  it('defers while the wallet is busy and keeps every card', async () => {
    const { listFungibles, rememberFungibleToken } = await import('./list')
    rememberFungibleToken({ ...card(), seenAt: 1 })
    regions.idle = () => false

    expect((await listFungibles()).map((t) => t.tokenId)).toEqual([TOKEN])
    expect(liveReads).toBe(0)
    expect(reported).toEqual([])
  })

  it('keeps every card when the wallet went busy during the read', async () => {
    const { listFungibles, rememberFungibleToken } = await import('./list')
    rememberFungibleToken({ ...card(), seenAt: 1 })
    liveRead.run = async () => {
      regions.idle = () => false
      return []
    }

    expect((await listFungibles()).map((t) => t.tokenId)).toEqual([TOKEN])
    expect(reported).toEqual([])
  })

  it('keeps every card when a send began and ended inside the read', async () => {
    const { listFungibles, rememberFungibleToken } = await import('./list')
    rememberFungibleToken({ ...card(), seenAt: 1 })
    liveRead.run = async () => {
      // Idle before and after, but the spend region was entered mid-read.
      regions.generation += 1
      return []
    }

    expect((await listFungibles()).map((t) => t.tokenId)).toEqual([TOKEN])
    expect(reported).toEqual([])
  })

  /**
   * A receive can internalize and paint in the middle of a read. The read's
   * own snapshot predates that card, and the basket has not projected it yet,
   * so publishing the snapshot used to delete the transfer the wallet had
   * just accepted.
   */
  it('keeps a card painted while the read was in flight', async () => {
    const { listFungibles, rememberFungibleToken, getCachedFungibles } =
      await import('./list')
    rememberFungibleToken({
      ...card(),
      tokenId: OTHER,
      outpoint: OTHER,
      seenAt: 1,
    })
    liveRead.run = async () => {
      rememberFungibleToken(card())
      return []
    }

    const rows = await listFungibles()

    expect(rows.map((t) => t.tokenId)).toEqual([TOKEN])
    expect(getCachedFungibles().map((t) => t.tokenId)).toEqual([TOKEN])
  })

  it('keeps a new tip for a token already present in the stale live read', async () => {
    const { listFungibles, rememberFungibleToken, getCachedFungibles } =
      await import('./list')
    const old = card()
    rememberFungibleToken(old)
    liveRead.run = async () => {
      rememberFungibleToken({
        ...card(),
        amt: '50',
        outpoint: `${'ef'.repeat(32)}.0`,
      })
      expect(
        getCachedFungibles().find((row) => row.tokenId === TOKEN),
      ).toMatchObject({ amt: '550', utxoCount: 2 })
      return [old]
    }

    const rows = await listFungibles()
    const token = rows.find((row) => row.tokenId === TOKEN)

    expect(token).toMatchObject({ amt: '550', utxoCount: 2 })
    expect(token?.tipOutpoints).toHaveLength(2)
    expect(getCachedFungibles().find((row) => row.tokenId === TOKEN)?.amt).toBe(
      '550',
    )
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
