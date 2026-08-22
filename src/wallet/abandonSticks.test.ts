/**
 * Abandon has to outlive the orphan import-mark heal.
 *
 * Refresh re-claims 1-sat tips that are live on our address but missing from
 * the basket — that is what brings an inventory back after a thin IndexedDB.
 * A tip the holder deliberately forgot looks identical to such an orphan, so
 * without a durable abandon record the heal walks it straight back in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (k: string) => store.get(k) ?? null,
  durableSetItem: (k: string, v: string) => {
    store.set(k, v)
  },
  durableRemoveItem: (k: string) => {
    store.delete(k)
  },
}))

const TIP = 'a'.repeat(64) + '.0'
const OTHER = 'b'.repeat(64) + '.1'

describe('abandoned tips', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('records the abandon durably and independently of the sent window', async () => {
    const { markItemAbandoned, isItemAbandoned, isItemSent } = await import(
      './sentItemGuard'
    )

    markItemAbandoned(TIP)

    expect(isItemAbandoned(TIP)).toBe(true)
    expect(isItemAbandoned(OTHER)).toBe(false)
    // The 24h sent hide is a separate concern; abandon does not depend on it.
    expect(isItemSent(TIP)).toBe(false)
  })

  it('survives the expiry that releases an ordinary send', async () => {
    const { markItemsSent, markItemAbandoned, isItemSent, isItemAbandoned } =
      await import('./sentItemGuard')
    const { SENT_HIDE_MS } = await import('./sentItemGuard')

    markItemsSent([{ outpoint: TIP, txid: `abandon:${TIP}` }])
    markItemAbandoned(TIP)

    const afterExpiry = Date.now() + SENT_HIDE_MS + 1
    expect(isItemSent(TIP, afterExpiry)).toBe(false)
    expect(isItemAbandoned(TIP)).toBe(true)
  })

  it('normalizes underscore outpoints so the heal cannot miss a match', async () => {
    const { markItemAbandoned, isItemAbandoned } = await import('./sentItemGuard')

    markItemAbandoned(`${'c'.repeat(64)}_2`)

    expect(isItemAbandoned(`${'c'.repeat(64)}.2`)).toBe(true)
  })

  it('keeps the record across a reload of the module', async () => {
    const first = await import('./sentItemGuard')
    first.markItemAbandoned(TIP)

    vi.resetModules()
    const second = await import('./sentItemGuard')

    expect(second.isItemAbandoned(TIP)).toBe(true)
  })
})
