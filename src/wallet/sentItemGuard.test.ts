import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
  },
}))

describe('sentItemGuard', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
    vi.useRealTimers()
  })

  it('hides an outpoint a send just spent', async () => {
    const guard = await import('./sentItemGuard')
    guard.markItemsSent([{ outpoint: 'AA.0', txid: 'b'.repeat(64) }])

    expect(guard.isItemSent('aa.0')).toBe(true)
    expect(guard.isItemSent('aa.1')).toBe(false)
  })

  it('matches underscore outpoints from the latch basket', async () => {
    const guard = await import('./sentItemGuard')
    guard.markItemsSent(['aa.0'])

    expect(guard.isItemSent('aa_0')).toBe(true)
  })

  it('survives a reload mid-broadcast', async () => {
    const guard = await import('./sentItemGuard')
    guard.markItemsSent(['aa.0'])
    vi.resetModules()

    const guard2 = await import('./sentItemGuard')
    expect(guard2.isItemSent('aa.0')).toBe(true)
  })

  it('gives the item back when the send never confirmed', async () => {
    const guard = await import('./sentItemGuard')
    guard.markItemsSent(['aa.0'])

    const later = Date.now() + guard.SENT_HIDE_MS + 1
    expect(guard.isItemSent('aa.0', later)).toBe(false)
  })

  it('un-hides on request', async () => {
    const guard = await import('./sentItemGuard')
    guard.markItemsSent(['aa.0', 'bb.1'])
    guard.forgetItemsSent(['aa.0'])

    expect(guard.isItemSent('aa.0')).toBe(false)
    expect(guard.isItemSent('bb.1')).toBe(true)
  })
})
