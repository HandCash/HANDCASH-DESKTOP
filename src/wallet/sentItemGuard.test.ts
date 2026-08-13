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

  it('hides outbound remittance tips filed by soft-latch createAction', async () => {
    const guard = await import('./sentItemGuard')
    const txid = 'c'.repeat(64)
    guard.markItemsSent([
      { outpoint: 'old.0', txid },
      { outpoint: `${txid}.0`, txid },
      { outpoint: `${txid}.1`, txid },
    ])
    expect(guard.isItemSent('old.0')).toBe(true)
    expect(guard.isItemSent(`${txid}.0`)).toBe(true)
    expect(guard.isItemSent(`${txid}.1`)).toBe(true)
  })

  it('heals hides whose spend txid is missing from the chain', async () => {
    const guard = await import('./sentItemGuard')
    const activity = await import('./appActivity')
    const ghost = 'a'.repeat(64)
    const real = 'b'.repeat(64)
    guard.markItemsSent([
      { outpoint: 'tip.0', txid: ghost },
      { outpoint: 'latch.1', txid: ghost },
      { outpoint: 'kept.0', txid: real },
      { outpoint: 'abandon.0', txid: 'abandon:tip.0' },
    ])
    activity.noteOutboundSendComplete({
      pendingId: 'ghost-send',
      txid: ghost,
      sats: 1,
      to: '1abc',
      item: { name: 'Fox', origin: 'tip_0', outpoint: 'tip.0' },
    })
    const healed = await guard.healGhostSentItems(
      'main',
      async (txid) => (txid === ghost ? false : true),
      Date.now() + guard.SENDER_GHOST_GRACE_MS + 1,
    )
    expect(healed.sort()).toEqual(['latch.1', 'tip.0'])
    expect(guard.isItemSent('tip.0')).toBe(false)
    expect(guard.isItemSent('latch.1')).toBe(false)
    expect(guard.isItemSent('kept.0')).toBe(true)
    expect(guard.isItemSent('abandon.0')).toBe(true)
    expect(activity.listRecentActivity(10).some((e) => e.txid === ghost)).toBe(
      false,
    )
  })

  it('keeps hides when the chain lookup is inconclusive', async () => {
    const guard = await import('./sentItemGuard')
    const ghost = 'c'.repeat(64)
    guard.markItemsSent([{ outpoint: 'tip.0', txid: ghost }])
    const healed = await guard.healGhostSentItems('main', async () => null)
    expect(healed).toEqual([])
    expect(guard.isItemSent('tip.0')).toBe(true)
  })

  it('does not treat a fresh 404 as a ghost send', async () => {
    // Chain ingest runs seconds after createAction. Restoring that fast handed
    // the tip back mid-flight and deleted the Sent row.
    const guard = await import('./sentItemGuard')
    const txid = 'd'.repeat(64)
    guard.markItemsSent([{ outpoint: 'tip.0', txid }])

    const healed = await guard.healGhostSentItems('main', async () => false)

    expect(healed).toEqual([])
    expect(guard.isItemSent('tip.0')).toBe(true)
  })

  it('keeps a peerDeliver send hidden and its Activity row intact on a 404', async () => {
    // The payee broadcasts a peerDeliver settle, so a 404 hours later is still
    // normal. Deleting the row here is what left the details panel showing
    // "Transaction not found" for a transfer that really happened.
    const guard = await import('./sentItemGuard')
    const activity = await import('./appActivity')
    const txid = 'e'.repeat(64)
    guard.markItemsSent([{ outpoint: 'tip.0', txid, settle: 'peerDeliver' }])
    activity.noteOutboundSendComplete({
      pendingId: 'peer-send',
      txid,
      sats: 1,
      to: '1abc',
      item: { name: 'Fox', origin: 'tip_0', outpoint: 'tip.0' },
    })

    const healed = await guard.healGhostSentItems(
      'main',
      async () => false,
      Date.now() + guard.SENDER_GHOST_GRACE_MS + 1,
    )

    expect(healed).toEqual([])
    expect(guard.isItemSent('tip.0')).toBe(true)
    expect(activity.listRecentActivity(10).some((e) => e.txid === txid)).toBe(
      true,
    )
  })

  it('returns a peerDeliver tip the payee never broadcast, keeping the row', async () => {
    const guard = await import('./sentItemGuard')
    const activity = await import('./appActivity')
    const txid = 'f'.repeat(64)
    guard.markItemsSent([{ outpoint: 'tip.0', txid, settle: 'peerDeliver' }])
    activity.noteOutboundSendComplete({
      pendingId: 'peer-send-stale',
      txid,
      sats: 1,
      to: '1abc',
      item: { name: 'Fox', origin: 'tip_0', outpoint: 'tip.0' },
    })

    const healed = await guard.healGhostSentItems(
      'main',
      async () => false,
      Date.now() + guard.PEER_DELIVER_GHOST_GRACE_MS + 1,
    )

    expect(healed).toEqual(['tip.0'])
    expect(guard.isItemSent('tip.0')).toBe(false)
    // The tip came back, but the send still happened — keep the evidence.
    expect(activity.listRecentActivity(10).some((e) => e.txid === txid)).toBe(
      true,
    )
  })
})
