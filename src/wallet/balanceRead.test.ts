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

  /**
   * The consolidation bug: inputs sealed, replacement output not internalized
   * yet. Storage answers successfully with a total that is true of neither the
   * wallet before nor the wallet after, and publishing it emptied the hero.
   */
  it('refuses to publish a torn read while own funds are mid-rewrite', async () => {
    const { fetchBalanceRead, fetchBalanceSats } = await import('./session')
    const { beginSelfFundsRewrite } = await import('./selfFundsRewrite')

    await fetchBalanceRead(readableWallet(1_079_500) as never)

    const endRewrite = beginSelfFundsRewrite()
    // Storage would happily report the sealed-but-not-replaced total.
    const torn = await fetchBalanceRead(readableWallet(8_626) as never)
    expect(torn).toEqual({ kind: 'unavailable', reason: 'fundsMidRewrite' })
    // The hero keeps the last figure it actually owned.
    await expect(fetchBalanceSats(readableWallet(8_626) as never)).resolves.toBe(
      1_079_500,
    )

    endRewrite()
    await expect(
      fetchBalanceRead(readableWallet(1_888_000) as never),
    ).resolves.toEqual({ kind: 'ok', sats: 1_888_000 })
  })

  it('closes the rewrite window once even if the closer is called twice', async () => {
    const { fetchBalanceRead } = await import('./session')
    const { beginSelfFundsRewrite } = await import('./selfFundsRewrite')

    const endRewrite = beginSelfFundsRewrite()
    endRewrite()
    endRewrite()

    await expect(fetchBalanceRead(readableWallet(42) as never)).resolves.toEqual({
      kind: 'ok',
      sats: 42,
    })
  })

  it('stays closed until every overlapping rewrite ends', async () => {
    const { fetchBalanceRead } = await import('./session')
    const { beginSelfFundsRewrite } = await import('./selfFundsRewrite')

    const first = beginSelfFundsRewrite()
    const second = beginSelfFundsRewrite()
    first()
    expect(await fetchBalanceRead(readableWallet(42) as never)).toEqual({
      kind: 'unavailable',
      reason: 'fundsMidRewrite',
    })
    second()
    expect(await fetchBalanceRead(readableWallet(42) as never)).toEqual({
      kind: 'ok',
      sats: 42,
    })
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

  it('invalidates coalesced flights so a post-credit read is fresh', async () => {
    const { fetchBalanceSats, invalidateBalanceReads } = await import('./session')
    let reads = 0
    let release!: (sats: number) => void
    const pending = new Promise<number>((resolve) => {
      release = resolve
    })
    const wallet = {
      balance: async () => {
        reads += 1
        if (reads === 1) return pending
        return 99_000
      },
      listOutputs: async () => ({ outputs: [] }),
    }

    const stale = fetchBalanceSats(wallet as never)
    invalidateBalanceReads(wallet)
    const fresh = fetchBalanceSats(wallet as never)
    release(12_345)

    await expect(stale).resolves.toBe(12_345)
    await expect(fresh).resolves.toBe(99_000)
    expect(reads).toBe(2)
  })
})
