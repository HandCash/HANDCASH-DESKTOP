/**
 * Remittance outbox retry — concurrent flush must not lose or duplicate rows,
 * and must never imply a second payment tx.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (k: string) => store.get(k) ?? null,
  durableSetItem: (k: string, v: string) => {
    store.set(k, v)
  },
}))

type NotifyArgs = { txid: string; satoshis: number; atomicBeef?: number[] }
type NotifyResult = { delivered: 'local' | 'cloud'; beefInBox: boolean }

const notifyPeerBrc29Payment = vi.fn(
  async (_args: NotifyArgs): Promise<NotifyResult> => ({
    delivered: 'cloud',
    beefInBox: true,
  }),
)

vi.mock('./messageTransport', () => ({
  notifyPeerBrc29Payment: (args: unknown) =>
    notifyPeerBrc29Payment(args as NotifyArgs),
}))

vi.mock('./session', () => ({
  getActiveWallet: () => ({ chain: 'main' }),
}))

vi.mock('./beefCache', () => ({
  getBeefForTxidCached: async () => ({ toBinaryAtomic: () => [1, 2, 3] }),
}))

const KEY = 'handcash.brc29.pendingOutbox.v1'
const ROOT = 'ab'.repeat(32)

const row = (n: number) => ({
  payeeIdentityKey: '02' + 'bb'.repeat(32),
  senderIdentityKey: '03' + 'aa'.repeat(32),
  txid: n.toString(16).padStart(2, '0').repeat(32),
  satoshis: 100 + n,
  remittance: { derivationPrefix: 'pre', derivationSuffix: 'suf', outputIndex: 0 },
  createdAt: Date.now(),
  attempts: 0,
})

const savedRows = (): Array<{ txid: string; attempts: number }> =>
  JSON.parse(store.get(KEY) ?? '[]')

beforeEach(() => {
  store.clear()
  notifyPeerBrc29Payment.mockClear()
  notifyPeerBrc29Payment.mockImplementation(async () => ({
    delivered: 'cloud',
    beefInBox: true,
  }))
})

describe('flushPendingBrc29Outbox', () => {
  it('does no work and touches no network on an empty outbox', async () => {
    const { flushPendingBrc29Outbox } = await import('./pendingBrc29Outbox')
    expect(await flushPendingBrc29Outbox({ rootKeyHex: ROOT })).toBe(0)
    expect(notifyPeerBrc29Payment).not.toHaveBeenCalled()
  })

  it('delivers every queued remittance and clears the queue', async () => {
    store.set(KEY, JSON.stringify([row(1), row(2), row(3)]))
    const { flushPendingBrc29Outbox } = await import('./pendingBrc29Outbox')

    expect(await flushPendingBrc29Outbox({ rootKeyHex: ROOT })).toBe(3)
    expect(notifyPeerBrc29Payment).toHaveBeenCalledTimes(3)
    expect(savedRows()).toEqual([])
  })

  it('retries rows concurrently, bounded at three', async () => {
    store.set(KEY, JSON.stringify(Array.from({ length: 8 }, (_, i) => row(i + 1))))
    let inFlight = 0
    let peak = 0
    notifyPeerBrc29Payment.mockImplementation(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 10))
      inFlight -= 1
      return { delivered: 'cloud', beefInBox: true }
    })

    const { flushPendingBrc29Outbox } = await import('./pendingBrc29Outbox')
    expect(await flushPendingBrc29Outbox({ rootKeyHex: ROOT })).toBe(8)
    expect(peak).toBe(3)
  })

  it('keeps an undelivered row and counts the attempt', async () => {
    store.set(KEY, JSON.stringify([row(1)]))
    notifyPeerBrc29Payment.mockImplementation(async () => ({
      delivered: 'local',
      beefInBox: false,
    }))

    const { flushPendingBrc29Outbox } = await import('./pendingBrc29Outbox')
    expect(await flushPendingBrc29Outbox({ rootKeyHex: ROOT })).toBe(0)

    const kept = savedRows()
    expect(kept).toHaveLength(1)
    expect(kept[0]?.attempts).toBe(1)
  })

  it('keeps a row whose delivery threw, rather than dropping the remittance', async () => {
    store.set(KEY, JSON.stringify([row(1)]))
    notifyPeerBrc29Payment.mockImplementation(async () => {
      throw new Error('box unreachable')
    })

    const { flushPendingBrc29Outbox } = await import('./pendingBrc29Outbox')
    expect(await flushPendingBrc29Outbox({ rootKeyHex: ROOT })).toBe(0)
    expect(savedRows()).toHaveLength(1)
  })

  it('keeps only the failures when a batch is mixed', async () => {
    store.set(KEY, JSON.stringify([row(1), row(2), row(3)]))
    notifyPeerBrc29Payment.mockImplementation(async ({ txid }) =>
      txid === row(2).txid
        ? { delivered: 'local', beefInBox: false }
        : { delivered: 'cloud', beefInBox: true },
    )

    const { flushPendingBrc29Outbox } = await import('./pendingBrc29Outbox')
    expect(await flushPendingBrc29Outbox({ rootKeyHex: ROOT })).toBe(2)

    const kept = savedRows()
    expect(kept.map((r) => r.txid)).toEqual([row(2).txid])
  })

  it('gives up on a row that has exhausted its attempts', async () => {
    store.set(KEY, JSON.stringify([{ ...row(1), attempts: 19 }]))
    notifyPeerBrc29Payment.mockImplementation(async () => ({
      delivered: 'local',
      beefInBox: false,
    }))

    const { flushPendingBrc29Outbox } = await import('./pendingBrc29Outbox')
    await flushPendingBrc29Outbox({ rootKeyHex: ROOT })

    expect(savedRows()).toEqual([])
  })
})

describe('enqueuePendingBrc29Remit', () => {
  it('replaces an existing row for the same txid instead of duplicating it', async () => {
    const { enqueuePendingBrc29Remit } = await import('./pendingBrc29Outbox')
    enqueuePendingBrc29Remit(row(1))
    enqueuePendingBrc29Remit({ ...row(1), satoshis: 999 })

    expect(savedRows()).toHaveLength(1)
  })

  it('refuses a malformed txid', async () => {
    const { enqueuePendingBrc29Remit } = await import('./pendingBrc29Outbox')
    enqueuePendingBrc29Remit({ ...row(1), txid: 'nope' })

    expect(store.get(KEY)).toBeUndefined()
  })
})
