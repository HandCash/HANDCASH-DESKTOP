/**
 * Item remittance outbox retry — concurrent flush must not lose or duplicate rows,
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

type NotifyArgs = { txid: string; itemName: string; atomicBeef?: number[] }
type NotifyResult = { delivered: 'local' | 'cloud'; beefInBox: boolean }

const notifyPeerItemIncoming = vi.fn(
  async (_args: NotifyArgs): Promise<NotifyResult> => ({
    delivered: 'cloud',
    beefInBox: true,
  }),
)

vi.mock('./messageTransport', () => ({
  notifyPeerItemIncoming: (args: unknown) =>
    notifyPeerItemIncoming(args as NotifyArgs),
}))

vi.mock('./session', () => ({
  getActiveWallet: () => ({ chain: 'main' }),
}))

vi.mock('./beefCache', () => ({
  getBeefForTxidCached: async () => ({ toBinaryAtomic: () => [1, 2, 3] }),
}))

const KEY = 'handcash.item.pendingOutbox.v1'
const ROOT = 'ab'.repeat(32)

const row = (n: number) => ({
  payeeIdentityKey: '02' + 'bb'.repeat(32),
  senderIdentityKey: '03' + 'aa'.repeat(32),
  txid: n.toString(16).padStart(2, '0').repeat(32),
  itemName: `Item ${n}`,
  createdAt: Date.now(),
  attempts: 0,
})

const savedRows = (): Array<{ txid: string; attempts: number }> =>
  JSON.parse(store.get(KEY) ?? '[]')

beforeEach(() => {
  store.clear()
  notifyPeerItemIncoming.mockClear()
  notifyPeerItemIncoming.mockImplementation(async () => ({
    delivered: 'cloud',
    beefInBox: true,
  }))
})

describe('flushPendingItemOutbox', () => {
  it('does no work and touches no network on an empty outbox', async () => {
    const { flushPendingItemOutbox } = await import('./pendingItemOutbox')
    expect(await flushPendingItemOutbox({ rootKeyHex: ROOT })).toBe(0)
    expect(notifyPeerItemIncoming).not.toHaveBeenCalled()
  })

  it('delivers every queued remittance and clears the queue', async () => {
    store.set(KEY, JSON.stringify([row(1), row(2), row(3)]))
    const { flushPendingItemOutbox } = await import('./pendingItemOutbox')

    expect(await flushPendingItemOutbox({ rootKeyHex: ROOT })).toBe(3)
    expect(notifyPeerItemIncoming).toHaveBeenCalledTimes(3)
    expect(savedRows()).toEqual([])
  })

  it('keeps rows that still fail after retry', async () => {
    store.set(KEY, JSON.stringify([row(1)]))
    notifyPeerItemIncoming.mockResolvedValue({ delivered: 'local', beefInBox: false })
    const { flushPendingItemOutbox } = await import('./pendingItemOutbox')

    expect(await flushPendingItemOutbox({ rootKeyHex: ROOT })).toBe(0)
    expect(savedRows()).toEqual([expect.objectContaining({ attempts: 1 })])
  })
})
