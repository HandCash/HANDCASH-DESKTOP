import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

const TXID = 'a'.repeat(64)

describe('reconcilePendingSends', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  /** A send interrupted `ageMs` ago, with or without the txid that commits it. */
  function seedPending(args: { ageMs: number; txid?: string; sats?: number }) {
    store.set(
      'handcash.brc100.pendingSend',
      JSON.stringify([
        {
          id: 'p1',
          to: '1RecipientAddress',
          sats: args.sats ?? 5000,
          friendLabel: null,
          startedAt: Date.now() - args.ageMs,
          ...(args.txid ? { txid: args.txid } : {}),
        },
      ]),
    )
  }

  it('records a send that reached a txid', async () => {
    seedPending({ ageMs: 60_000, txid: TXID })

    const { reconcilePendingSends } = await import('./pendingSend')
    expect(reconcilePendingSends()).toBe(1)

    const { listRecentActivity } = await import('./appActivity')
    expect(listRecentActivity(10)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'spent', sats: 5000, txid: TXID }),
      ]),
    )
  })

  it('never invents history for a send that never got a txid', async () => {
    seedPending({ ageMs: 60_000 })

    const { reconcilePendingSends } = await import('./pendingSend')
    expect(reconcilePendingSends()).toBe(0)

    const { listRecentActivity } = await import('./appActivity')
    expect(listRecentActivity(10)).toEqual([])
  })

  it('drops an uncommitted pending instead of retrying it forever', async () => {
    seedPending({ ageMs: 60_000 })

    const { reconcilePendingSends } = await import('./pendingSend')
    reconcilePendingSends()

    expect(store.get('handcash.brc100.pendingSend')).toBe('[]')
  })

  it('leaves a send that may still be in flight alone', async () => {
    seedPending({ ageMs: 1_000 })

    const { reconcilePendingSends } = await import('./pendingSend')
    expect(reconcilePendingSends()).toBe(0)

    const kept = JSON.parse(store.get('handcash.brc100.pendingSend') ?? '[]') as unknown[]
    expect(kept).toHaveLength(1)
  })

  it('does not double-record a txid history already has', async () => {
    seedPending({ ageMs: 60_000, txid: TXID })

    const { recordAppActivity, WALLET_ACTIVITY_ORIGIN, listRecentActivity } = await import(
      './appActivity'
    )
    recordAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'spent',
      sats: 5000,
      method: 'send',
      txid: TXID,
    })

    const { reconcilePendingSends } = await import('./pendingSend')
    expect(reconcilePendingSends()).toBe(0)
    expect(listRecentActivity(10).filter((e) => e.txid === TXID)).toHaveLength(1)
  })
})
