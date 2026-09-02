import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

import {
  activityDetailLabel,
  activityEntryKey,
  activityEntryTitle,
  activityNavLabel,
  activityRecipientLabel,
  formatActivityRecipientDisplay,
  clearAppActivity,
  hasSettledActivityTxid,
  isEventActivity,
  isItemActivity,
  isPendingActivity,
  listRecentActivity,
  noteInboundReceiveComplete,
  noteInboundReceivePending,
  noteOutboundSendComplete,
  noteOutboundSendPending,
  noteOutboundSendBroadcastFailed,
  failOutboundSendPending,
  isFailedActivity,
  activityFailureReason,
  activityFailureLabel,
  expireStaleInboundPending,
  expireStaleOutboundPending,
  pruneMissingOnChainActivity,
  removeActivityById,
  removeFailedActivity,
  countFailedActivity,
  recordWalletEvent,
  isFailedMarketListingActivity,
  removeActivityForTxids,
  reconcilePendingActivityWithHeldItems,
  healMisfiledOnesatFtReceives,
  upsertAppActivity,
  WALLET_ACTIVITY_ORIGIN,
  type ActivityEntry,
} from './appActivity'
import {
  __resetGhostTxSuppressForTests,
  isGhostTxSuppressed,
  rememberGhostTx,
} from './ghostTxSuppress'
import {
  __resetArcadeSubmitGuardForTests,
  rememberArcadeSubmitContact,
} from './arcadeSubmitGuard'

function entry(partial: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: '1',
    origin: 'handcash',
    kind: 'spent',
    sats: 1,
    at: 1,
    method: 'send',
    ...partial,
  }
}

describe('activityEntryTitle', () => {
  it('shows a friendly recipient instead of a raw identity key', () => {
    const row = entry({
      kind: 'spent',
      method: 'send',
      note: `Sent to me (${'0'.repeat(64)})`,
      retry: {
        kind: 'send-bsv',
        toAddress: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
        satoshis: 1000,
        friendLabel: 'me',
      },
    })
    expect(activityRecipientLabel(row)).toBe('myself')
    expect(activityEntryTitle(row)).toBe('Sent to myself')
  })

  it('labels mint tips with quantity, distinct from send/receive', () => {
    expect(
      activityEntryTitle(
        entry({
          kind: 'earned',
          method: 'mint-token',
          item: {
            name: 'DEMO',
            origin: 'aa_0',
            tokenId: 'aa_0',
            amt: '1000',
            dec: 0,
          },
        }),
      ),
    ).toBe('Minted 1,000 DEMO')
    expect(
      activityEntryTitle(
        entry({
          kind: 'spent',
          method: 'send-token',
          item: {
            name: 'DEMO',
            origin: 'aa_0',
            tokenId: 'aa_0',
            amt: '50',
          },
        }),
      ),
    ).toBe('Sent 50 DEMO')
    expect(
      activityEntryTitle(
        entry({
          kind: 'earned',
          method: 'receive-token',
          item: {
            name: 'DEMO',
            origin: 'aa_0',
            tokenId: 'aa_0',
            amt: '25',
          },
        }),
      ),
    ).toBe('Received 25 DEMO')
  })
})

describe('formatActivityRecipientDisplay', () => {
  it('drops parenthesized identity keys when a label is present', () => {
    expect(
      formatActivityRecipientDisplay({
        friendLabel: 'Alice',
        to: '0'.repeat(64),
      }),
    ).toBe('Alice')
    expect(
      formatActivityRecipientDisplay({
        friendLabel: 'me',
        to: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
      }),
    ).toBe('myself')
  })
})

describe('activityDetailLabel', () => {
  it('labels collectable rows as Transaction', () => {
    const row = entry({
      method: 'send-collectable',
      item: { name: 'Badge', origin: 'aa_0', outpoint: 'bb.0' },
    })
    expect(isItemActivity(row)).toBe(true)
    expect(activityDetailLabel(row)).toBe('Transaction')
  })

  it('labels app money rows as Payment', () => {
    expect(
      activityDetailLabel(
        entry({
          origin: 'https://market.example',
          method: 'createAction',
          sats: 1000,
        }),
      ),
    ).toBe('Payment')
  })

  it('labels wallet BSV sends as Transaction', () => {
    expect(activityDetailLabel(entry({ method: 'send', sats: 5000 }))).toBe(
      'Transaction',
    )
  })

  it('labels permission / friend rows as Activity', () => {
    const row = entry({
      kind: 'event',
      sats: 0,
      method: 'connect',
      note: 'Connected market.example',
      origin: 'market.example',
    })
    expect(isEventActivity(row)).toBe(true)
    expect(activityDetailLabel(row)).toBe('Activity')
    expect(activityEntryTitle(row)).toBe('Connected market.example')
    expect(activityNavLabel(row)).toBe('Connected market.example')
  })

  it('does not repeat Activity in the nav crumb for an approval', () => {
    const row = entry({
      kind: 'event',
      sats: 0,
      method: 'approve',
      note: 'List item for sale',
      origin: 'brc-cloud.bcryderman.workers.dev',
    })
    expect(activityNavLabel(row)).toBe('List item for sale')
  })
})

describe('activityEntryKey', () => {
  it('is the same for one transaction recorded twice', () => {
    // A restored history replica re-records the row with a fresh clock-minted id.
    // Keying the seen record on `id` is what made the top row flash on every visit.
    const local = entry({ id: '1770000000000-ab12', txid: 'AA', at: 10 })
    const restored = entry({ id: '1780000000000-cd34', txid: 'aa', at: 10 })

    expect(activityEntryKey(restored)).toBe(activityEntryKey(local))
  })

  it('separates the send and the receive of the same transaction', () => {
    const sent = entry({ txid: 'aa', kind: 'spent' })
    const earned = entry({ txid: 'aa', kind: 'earned' })

    expect(activityEntryKey(sent)).not.toBe(activityEntryKey(earned))
  })

  it('keys an item row with no txid on the tip and its own row id', () => {
    const row = entry({
      id: 'attempt-1',
      item: { name: 'Fox', origin: 'aa_0', outpoint: 'BB.0' },
    })
    expect(activityEntryKey(row)).toBe('item:bb.0:spent:attempt-1')
  })

  it('separates two attempts on the same tip that never produced a txid', () => {
    // Both died before signing, so neither has a txid to tell them apart. They
    // are still two rows, and React needs two keys.
    const item = { name: 'Fox', origin: 'aa_0', outpoint: 'BB.0' }
    const first = entry({ id: 'attempt-1', item, status: 'failed' })
    const second = entry({ id: 'attempt-2', item, status: 'failed' })

    expect(activityEntryKey(first)).not.toBe(activityEntryKey(second))
  })

  it('separates two send attempts that spent the same tip', () => {
    // A send the payee never broadcast returns the tip; sending it again leaves
    // two spent rows on one outpoint. Sharing a key made React drop one.
    const item = { name: 'Fox', origin: 'aa_0', outpoint: 'bb.0' }
    const first = entry({ txid: 'cc', item })
    const second = entry({ txid: 'dd', item })

    expect(activityEntryKey(first)).not.toBe(activityEntryKey(second))
  })

  it('still matches an item row re-recorded from restored history', () => {
    const item = { name: 'Fox', origin: 'aa_0', outpoint: 'BB.0' }
    const local = entry({ id: '1770000000000-ab12', txid: 'CC', item })
    const restored = entry({ id: '1780000000000-cd34', txid: 'cc', item })

    expect(activityEntryKey(restored)).toBe(activityEntryKey(local))
  })

  it('keys a local-only row on its timestamp', () => {
    expect(activityEntryKey(entry({ at: 42, sats: 7 }))).toBe('at:42:spent:7')
  })
})

describe('inbound receive activity', () => {
  const TX = 'a'.repeat(64)

  beforeEach(() => {
    store.clear()
    clearAppActivity()
    __resetGhostTxSuppressForTests()
    __resetArcadeSubmitGuardForTests()
  })

  it('shows a verifying payment in Activity before internalize finishes', () => {
    noteInboundReceivePending({ txid: TX, sats: 12_345 })
    const rows = listRecentActivity(10)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'earned',
      method: 'receive',
      sats: 12345,
      txid: TX,
      status: 'pending',
    })
    expect(isPendingActivity(rows[0]!)).toBe(true)
    expect(hasSettledActivityTxid(TX, 'earned', { item: false })).toBe(false)
  })

  it('promotes the same row when ingest settles (no duplicate)', () => {
    noteInboundReceivePending({ txid: TX, sats: 100 })
    noteInboundReceiveComplete({ txid: TX, sats: 100 })
    const rows = listRecentActivity(10).filter((e) => e.txid === TX)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBeUndefined()
    expect(rows[0]?.sats).toBe(100)
    expect(hasSettledActivityTxid(TX, 'earned', { item: false })).toBe(true)
  })

  it('keeps item and BSV receives on the same txid as separate rows', () => {
    noteInboundReceivePending({ txid: TX, sats: 5000 })
    noteInboundReceivePending({
      txid: TX,
      item: true,
      itemName: 'Fox',
    })
    noteInboundReceiveComplete({ txid: TX, sats: 5000 })
    noteInboundReceiveComplete({
      txid: TX,
      item: true,
      itemName: 'Fox',
      outpoint: `${TX}.0`,
    })
    const rows = listRecentActivity(10).filter((e) => e.txid === TX)
    expect(rows).toHaveLength(2)
    expect(rows.some((e) => e.method === 'receive' && !e.item)).toBe(true)
    expect(
      rows.some(
        (e) => e.method === 'receive-collectable' && e.item?.name === 'Fox',
      ),
    ).toBe(true)
  })

  it('promotes a fungible settle as receive-token with token metadata', () => {
    const token = {
      tokenId: `${'ab'.repeat(32)}_0`,
      amount: '125',
      sym: 'TST',
      dec: 2,
    }
    noteInboundReceivePending({
      txid: TX,
      item: true,
      itemName: token.sym,
      token,
    })
    noteInboundReceiveComplete({
      txid: TX,
      item: true,
      itemName: token.sym,
      outpoint: `${TX}.0`,
      token,
    })
    const rows = listRecentActivity(10).filter((e) => e.txid === TX)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      method: 'receive-token',
      note: 'Received 1.25 TST',
      status: undefined,
      item: {
        tokenId: token.tokenId,
        amt: '125',
        dec: 2,
        outpoint: `${TX}.0`,
      },
    })
  })

  it('does not take a settled receive back to verifying', () => {
    noteInboundReceiveComplete({ txid: TX, sats: 9 })
    noteInboundReceivePending({ txid: TX, sats: 9 })
    const row = listRecentActivity(10).find((e) => e.txid === TX)
    expect(row?.status).toBeUndefined()
    expect(isPendingActivity(row!)).toBe(false)
  })

  it('clears stale Verifying when the tip is already held in inventory', () => {
    noteInboundReceivePending({
      txid: TX,
      item: true,
      itemName: 'Fox',
      outpoint: `${TX}.0`,
    })
    expect(isPendingActivity(listRecentActivity(10)[0]!)).toBe(true)
    const cleared = reconcilePendingActivityWithHeldItems([
      { outpoint: `${TX}.0`, proven: true, name: 'Fox', origin: `${TX}_0` },
    ])
    expect(cleared).toBe(1)
    expect(isPendingActivity(listRecentActivity(10)[0]!)).toBe(false)
  })

  it('expires stale Verifying receives that never internalized', () => {
    noteInboundReceivePending({
      txid: TX,
      item: true,
      itemName: 'Fox',
      outpoint: `${TX}.0`,
    })
    expect(isPendingActivity(listRecentActivity(10)[0]!)).toBe(true)
    expect(expireStaleInboundPending(60_000, Date.now() + 61_000)).toBe(1)
    expect(listRecentActivity(10)).toHaveLength(0)
  })

  it('adds Sending… for a re-send after a settled spend of the same tip', () => {
    noteOutboundSendPending({
      pendingId: 'old-send',
      sats: 1,
      to: '1abc',
      item: { name: 'Fox', origin: `${TX}_0`, outpoint: `${TX}.0` },
    })
    noteOutboundSendComplete({
      pendingId: 'old-send',
      txid: 'aa'.repeat(32),
      sats: 1,
      to: '1abc',
      item: { name: 'Fox', origin: `${TX}_0`, outpoint: `${TX}.0` },
    })
    expect(
      listRecentActivity(10).filter(
        (e) => e.item?.outpoint === `${TX}.0` && e.kind === 'spent',
      ),
    ).toHaveLength(1)

    noteOutboundSendPending({
      pendingId: 'new-send',
      sats: 1,
      to: '1xyz',
      item: { name: 'Fox', origin: `${TX}_0`, outpoint: `${TX}.0` },
    })
    const rows = listRecentActivity(10).filter(
      (e) => e.item?.outpoint === `${TX}.0` && e.kind === 'spent',
    )
    expect(rows).toHaveLength(2)
    expect(
      rows.some((e) => e.status === 'pending' && e.pendingId === 'new-send'),
    ).toBe(true)
    expect(rows.some((e) => e.status !== 'pending' && e.txid)).toBe(true)
  })

  it('persists the exact recipient details required to retry an item send', () => {
    noteOutboundSendPending({
      pendingId: 'retryable',
      sats: 1,
      to: '1retry',
      friendLabel: 'Alice',
      recipientIdentityKey: '02'.padEnd(66, '1'),
      item: { name: 'Fox', origin: `${TX}_0`, outpoint: `${TX}.0` },
    })
    noteOutboundSendComplete({
      pendingId: 'retryable',
      txid: 'cc'.repeat(32),
      sats: 1,
      to: '1retry',
      friendLabel: 'Alice',
      recipientIdentityKey: '02'.padEnd(66, '1'),
      item: { name: 'Fox', origin: `${TX}_0`, outpoint: `${TX}.0` },
    })

    expect(listRecentActivity(10)[0]?.retry).toEqual({
      kind: 'send-collectable',
      outpoint: `${TX}.0`,
      toAddress: '1retry',
      friendLabel: 'Alice',
      recipientIdentityKey: '02'.padEnd(66, '1'),
    })
  })

  it('deletes one local attempt by id without touching another row', () => {
    noteOutboundSendPending({
      pendingId: 'delete-me',
      sats: 1,
      to: '1abc',
      item: { name: 'Fox', origin: `${TX}_0`, outpoint: `${TX}.0` },
    })
    noteInboundReceiveComplete({ txid: 'dd'.repeat(32), sats: 10 })
    const attempt = listRecentActivity(10).find(
      (row) => row.pendingId === 'delete-me',
    )!

    expect(removeActivityById(attempt.id)).toBe(true)
    expect(listRecentActivity(10).some((row) => row.id === attempt.id)).toBe(
      false,
    )
    expect(listRecentActivity(10)).toHaveLength(1)
    expect(removeActivityById(attempt.id)).toBe(false)
  })

  it('counts and bulk-removes every failed send, keeping healthy rows', () => {
    for (const id of ['fail-a', 'fail-b', 'fail-c']) {
      noteOutboundSendPending({ pendingId: id, sats: 100, to: '1abc' })
      failOutboundSendPending({ pendingId: id, reason: 'Broadcast refused' })
    }
    noteOutboundSendPending({ pendingId: 'live', sats: 200, to: '1abc' })
    noteInboundReceiveComplete({ txid: 'dd'.repeat(32), sats: 10 })

    expect(countFailedActivity()).toBe(3)

    expect(removeFailedActivity()).toBe(3)
    expect(countFailedActivity()).toBe(0)
    expect(removeFailedActivity()).toBe(0)

    const rows = listRecentActivity(20)
    expect(rows.some((r) => r.pendingId === 'live')).toBe(true)
    expect(rows.some((r) => r.txid === 'dd'.repeat(32))).toBe(true)
    expect(rows.every((r) => r.status !== 'failed')).toBe(true)
  })

  it('rewrites a settled send when background broadcast hard-fails', () => {
    noteOutboundSendPending({ pendingId: 'late-fail', sats: 500, to: '1abc' })
    noteOutboundSendComplete({
      pendingId: 'late-fail',
      txid: TX,
      sats: 500,
      to: '1abc',
    })
    expect(noteOutboundSendBroadcastFailed({
      pendingId: 'late-fail',
      txid: TX,
      reason: 'Already spent',
    })).toBe(true)
    const row = listRecentActivity(10)[0]!
    expect(isFailedActivity(row)).toBe(true)
    expect(activityFailureReason(row)).toBe('Already spent')
    expect(row.note).toBe(`Failed: Sent to 1abc`)
  })

  it('marks stale Sending… rows as failed with a reason', () => {
    noteOutboundSendPending({
      pendingId: 'stuck',
      sats: 1000,
      to: '1abc',
    })
    expect(isPendingActivity(listRecentActivity(10)[0]!)).toBe(true)
    expect(expireStaleOutboundPending(90_000, Date.now() + 91_000)).toBe(1)
    const row = listRecentActivity(10)[0]!
    expect(isFailedActivity(row)).toBe(true)
    expect(activityFailureReason(row)).toBe('Timed out')
    expect(activityFailureLabel(row)).toBe('Timed out')
    expect(activityEntryTitle(row)).toBe('Send failed')
  })

  it('labels failed market listings separately from sends', () => {
    recordWalletEvent({
      method: 'market-list',
      note: 'Failed: Listed KING for 5,000 sats',
      status: 'failed',
      failureReason: 'amt-mismatch',
      item: { name: 'KING', origin: 'aa'.repeat(32) },
    })
    const row = listRecentActivity(10)[0]!
    expect(activityEntryTitle(row)).toBe('KING listing failed')
    expect(isFailedMarketListingActivity(row)).toBe(true)
  })

  it('surfaces amt-mismatch / ITEM_ORIGIN_UNPROVEN when failureReason is an object', () => {
    noteOutboundSendPending({
      pendingId: 'obj-fail',
      sats: 500,
      to: '1abc',
    })
    expect(
      failOutboundSendPending({
        pendingId: 'obj-fail',
        reason: {
          code: 'ITEM_ORIGIN_UNPROVEN',
          description: 'amt-mismatch',
        },
      }),
    ).toBe(true)
    const row = listRecentActivity(10)[0]!
    expect(activityFailureReason(row)).toBe('amt-mismatch')
    expect(activityFailureLabel(row)).toBe('amt-mismatch')
  })

  it('keeps a failed send in Activity with the why', () => {
    noteOutboundSendPending({
      pendingId: 'poison',
      sats: 500,
      to: '1abc',
    })
    expect(
      failOutboundSendPending({
        pendingId: 'poison',
        reason: 'undefined is not iterable',
      }),
    ).toBe(true)
    const row = listRecentActivity(10)[0]!
    expect(isFailedActivity(row)).toBe(true)
    expect(activityFailureReason(row)).toBe('undefined is not iterable')
    expect(activityFailureLabel(row)).toBe('Missing script')
    expect(row.sats).toBe(500)
    // A second fail on an already-failed row is a no-op.
    expect(
      failOutboundSendPending({
        pendingId: 'poison',
        reason: 'should not replace',
      }),
    ).toBe(false)
    expect(activityFailureReason(listRecentActivity(10)[0]!)).toBe(
      'undefined is not iterable',
    )
  })

  it('prunes settled Activity rows whose txid 404s on-chain', async () => {
    noteOutboundSendComplete({
      pendingId: 'ghost',
      txid: 'bb'.repeat(32),
      sats: 500,
      to: '1abc',
    })
    expect(listRecentActivity(10)).toHaveLength(1)
    const pruned = await pruneMissingOnChainActivity(
      'main',
      async () => false,
      { minAgeMs: 0 },
    )
    expect(pruned).toBe(1)
    expect(listRecentActivity(10)).toHaveLength(0)
  })

  it('keeps a settled item send whose txid 404s (payee has not broadcast)', async () => {
    // peerDeliver: the payee broadcasts, so a 404 is expected for a while. The
    // tip already left the basket — pruning the row leaves the details panel
    // showing "Transaction not found" for a transfer that really happened.
    noteOutboundSendComplete({
      pendingId: 'item-send',
      txid: 'ee'.repeat(32),
      sats: 1,
      to: '1abc',
      item: { name: 'Pixel Fox', origin: 'aa_0', outpoint: 'aa.0' },
    })
    expect(listRecentActivity(10)).toHaveLength(1)

    const pruned = await pruneMissingOnChainActivity(
      'main',
      async () => false,
      { minAgeMs: 0 },
    )

    expect(pruned).toBe(0)
    expect(listRecentActivity(10)[0]?.item?.name).toBe('Pixel Fox')
  })

  it('prunes aged pending BSV Verifying… on 404 but keeps pending collectables', async () => {
    noteInboundReceivePending({ txid: 'cc'.repeat(32), sats: 100 })
    noteInboundReceivePending({
      txid: 'dd'.repeat(32),
      item: true,
      itemName: 'Fox',
    })
    const aged = listRecentActivity(10).map((e) => ({
      ...e,
      at: Date.now() - 120_000,
    }))
    store.set('handcash.brc100.appActivity', JSON.stringify(aged))

    const pruned = await pruneMissingOnChainActivity(
      'main',
      async () => false,
      {
        minAgeMs: 0,
        pendingMinAgeMs: 60_000,
      },
    )
    expect(pruned).toBe(1)
    const left = listRecentActivity(10)
    expect(left).toHaveLength(1)
    expect(left[0]?.item?.name).toBe('Fox')
    expect(isGhostTxSuppressed('cc'.repeat(32))).toBe(true)
  })

  it('refuses to re-pin Verifying… for a suppressed ghost txid', () => {
    rememberGhostTx(TX)
    noteInboundReceivePending({
      txid: TX,
      sats: 99,
      item: true,
      itemName: 'Fox',
    })
    expect(listRecentActivity(10)).toHaveLength(0)
  })

  it('removeActivityForTxids drops Sent rows for ghost attempts', () => {
    noteOutboundSendComplete({
      pendingId: 'a',
      txid: TX,
      sats: 1,
      to: '1abc',
      item: { name: 'Fox', origin: `${TX}_0`, outpoint: `${TX}.0` },
    })
    expect(removeActivityForTxids([TX])).toBe(1)
    expect(listRecentActivity(10)).toHaveLength(0)
  })

  it('does not remove or fail rows pinned by Arcade submit', () => {
    rememberArcadeSubmitContact(TX)
    noteOutboundSendComplete({
      pendingId: 'arc',
      txid: TX,
      sats: 500,
      to: '1Pay',
    })
    expect(
      noteOutboundSendBroadcastFailed({ txid: TX, reason: 'Not sent' }),
    ).toBe(false)
    expect(removeActivityForTxids([TX])).toBe(0)
    expect(listRecentActivity(10)).toHaveLength(1)
  })

  it('labels irreversible burns as burns rather than sends', () => {
    const burn: ActivityEntry = {
      id: 'burn-1',
      origin: 'handcash',
      kind: 'spent',
      sats: 1,
      at: Date.now(),
      method: 'burn-token',
      status: 'complete',
      item: {
        name: 'CHIPS',
        origin: `${TX}_0`,
        tokenId: `${TX}_0`,
        amt: '25',
        dec: 0,
      },
    }
    expect(activityEntryTitle(burn)).toBe('Burned 25 CHIPS')
    expect(activityEntryTitle({ ...burn, status: 'pending' })).toBe('Burning CHIPS…')
    expect(activityEntryTitle({ ...burn, status: 'failed' })).toBe('CHIPS not burned')
  })
})

describe('burn activity handoff', () => {
  beforeEach(() => {
    store.clear()
    clearAppActivity()
  })

  it('keeps one visible row from queued through terminal failure', () => {
    const pendingId = 'burn-test'
    const item = {
      name: 'Fox',
      origin: `${'a'.repeat(64)}_0`,
      outpoint: `${'b'.repeat(64)}.0`,
    }
    upsertAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'spent',
      sats: 1,
      method: 'burn-collectable',
      item,
      burn: { asset: '1sat', destroyedAmount: '1' },
      status: 'pending',
      pendingId,
    })
    expect(listRecentActivity(10)[0]).toMatchObject({
      method: 'burn-collectable',
      status: 'pending',
      pendingId,
    })

    upsertAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'spent',
      sats: 1,
      method: 'burn-collectable',
      item,
      burn: { asset: '1sat', destroyedAmount: '1' },
      status: 'failed',
      pendingId,
      failureReason: 'source transaction timed out',
    })
    const rows = listRecentActivity(10)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      status: 'failed',
      failureReason: 'source transaction timed out',
    })
  })
})

describe('healMisfiledOnesatFtReceives', () => {
  const TX = '2a562450e7b7009e01f6924376f4081ccf43a46487a1fd06a3a975935c7dda19'
  const ORIGIN = '9c385c416f708fad7627db3dc2ab4f8b28acca7062dfb2dfe56db20e5f961ac4_0'

  beforeEach(() => {
    store.clear()
    clearAppActivity()
  })

  it('rewrites a receive-collectable KING row to receive-token', () => {
    upsertAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'earned',
      sats: 1,
      method: 'receive-collectable',
      note: 'Received KING',
      txid: TX,
      item: {
        name: 'KING',
        origin: ORIGIN,
        outpoint: `${TX}.0`,
      },
    })
    expect(
      healMisfiledOnesatFtReceives([
        { outpoint: `${TX}.0`, origin: ORIGIN, amt: 69, name: 'KING' },
      ]),
    ).toBe(1)
    const row = listRecentActivity(10).find((e) => e.txid === TX)
    expect(row).toMatchObject({
      method: 'receive-token',
      note: 'Received 69 KING',
      item: {
        tokenId: ORIGIN,
        amt: '69',
      },
    })
  })

  it('does not invent a row for a leftover-only tip', () => {
    upsertAppActivity({
      origin: WALLET_ACTIVITY_ORIGIN,
      kind: 'earned',
      sats: 1,
      method: 'receive-collectable',
      note: 'Received KING',
      txid: TX,
      item: {
        name: 'KING',
        origin: ORIGIN,
        outpoint: `${TX}.0`,
      },
    })
    healMisfiledOnesatFtReceives([
      { outpoint: `${TX}.0`, origin: ORIGIN, amt: 69, name: 'KING' },
    ])
    const before = listRecentActivity(20).length
    expect(
      healMisfiledOnesatFtReceives([
        {
          outpoint: `${TX}_1`,
          origin: ORIGIN,
          amt: 68931,
          name: 'KING',
        },
      ]),
    ).toBe(0)
    expect(listRecentActivity(20)).toHaveLength(before)
    expect(listRecentActivity(20).some((e) => e.note === 'Received 68,931 KING')).toBe(
      false,
    )
  })
})
