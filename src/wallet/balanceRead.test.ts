/**
 * A wallet must never say "$0.00" because storage was busy. These cover the
 * read contract: a total read failure is `unavailable`, and the displayed
 * number falls back to the last figure actually read rather than zero.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const unconfirmedChangeSats = vi.fn(async () => 0)

vi.mock('./balanceView', () => ({
  unconfirmedChangeSats: (...args: unknown[]) => unconfirmedChangeSats(...args),
}))

const BUSY = new Error('IndexedDB timed out')

/** A wallet whose every balance strategy fails, like a saturated device. */
function unreadableWallet() {
  return {
    balance: async () => {
      throw BUSY
    },
    listOutputs: async () => {
      throw BUSY
    },
  }
}

function readableWallet(sats: number) {
  return { balance: async () => sats, listOutputs: async () => ({ outputs: [] }) }
}

describe('fetchBalanceRead', () => {
  beforeEach(() => {
    vi.resetModules()
    unconfirmedChangeSats.mockReset()
    unconfirmedChangeSats.mockResolvedValue(0)
  })

  it('reports unavailable instead of zero when every strategy fails', async () => {
    const { fetchBalanceRead } = await import('./session')
    const read = await fetchBalanceRead(unreadableWallet() as never)
    expect(read).toEqual({ kind: 'unavailable', reason: 'storageUnreadable' })
  })

  it('reports a real zero as ok, so an empty wallet still reads as empty', async () => {
    const { fetchBalanceRead } = await import('./session')
    const read = await fetchBalanceRead(readableWallet(0) as never)
    expect(read).toEqual({ kind: 'ok', sats: 0 })
  })

  it('keeps the last read figure when a later read fails', async () => {
    const { fetchBalanceRead, fetchBalanceSats, lastKnownBalance } = await import(
      './session'
    )
    await fetchBalanceRead(readableWallet(8_228_900) as never)
    expect(lastKnownBalance()).toBe(8_228_900)

    // The scary case: storage goes busy and the hero number must not drop to 0.
    await expect(fetchBalanceSats(unreadableWallet() as never)).resolves.toBe(8_228_900)
  })

  it('fails closed to zero for confirmed-only reads used by spend gates', async () => {
    const { fetchBalanceRead, fetchBalanceSats } = await import('./session')
    await fetchBalanceRead(readableWallet(8_228_900) as never)
    await expect(
      fetchBalanceSats(unreadableWallet() as never, { creditUnconfirmed: false }),
    ).resolves.toBe(0)
  })

  it('does not let a confirmed-only read shrink the partner-app cache', async () => {
    unconfirmedChangeSats.mockResolvedValue(10_000)
    const { fetchBalanceSats, fetchFastBalanceSats } = await import('./session')
    const wallet = {
      balance: async () => 42_000,
      listOutputs: async () => ({ outputs: [] }),
    }

    await fetchBalanceSats(wallet as never)
    unconfirmedChangeSats.mockResolvedValue(0)
    await fetchBalanceSats(wallet as never, { creditUnconfirmed: false })

    await expect(fetchFastBalanceSats(wallet as never)).resolves.toBe(52_000)
  })

  it('returns a proven partner-app balance without waiting for its refresh', async () => {
    const { fetchBalanceSats, fetchFastBalanceSats } = await import('./session')
    let blocked = false
    const wallet = {
      balance: async () => {
        if (blocked) return new Promise<number>(() => {})
        return 42_000
      },
      listOutputs: async () => ({ outputs: [] }),
    }

    await fetchBalanceSats(wallet as never)
    blocked = true

    await expect(
      Promise.race([
        fetchFastBalanceSats(wallet as never),
        new Promise<number>((resolve) => setTimeout(() => resolve(-1), 25)),
      ]),
    ).resolves.toBe(42_000)
  })

  it('bounds a cold partner-app balance read while refreshing in background', async () => {
    const { fetchFastBalanceSats } = await import('./session')
    const wallet = {
      balance: async () => new Promise<number>(() => {}),
      listOutputs: async () => new Promise<never>(() => {}),
    }

    await expect(fetchFastBalanceSats(wallet as never, 10)).resolves.toBe(0)
  })

  it('coalesces concurrent display reads into one storage pass', async () => {
    const { fetchBalanceSats } = await import('./session')
    let reads = 0
    let release!: (sats: number) => void
    const pending = new Promise<number>((resolve) => {
      release = resolve
    })
    const wallet = {
      balance: async () => {
        reads += 1
        return pending
      },
      listOutputs: async () => ({ outputs: [] }),
    }

    const first = fetchBalanceSats(wallet as never)
    const second = fetchBalanceSats(wallet as never)
    release(12_345)

    await expect(Promise.all([first, second])).resolves.toEqual([12_345, 12_345])
    expect(reads).toBe(1)
  })
})
