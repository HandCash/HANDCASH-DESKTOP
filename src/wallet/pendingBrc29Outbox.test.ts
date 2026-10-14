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
    return true
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

const getBeefForTxidCached = vi.fn(async (): Promise<{ toBinaryAtomic: () => number[] }> => ({
  toBinaryAtomic: () => [1, 2, 3],
}))
vi.mock('./beefCache', () => ({
  getBeefForTxidCached: () => getBeefForTxidCached(),
}))

vi.mock('./historyBackupPrefs', () => ({ resolveHistoryBackupBaseUrl: () => null }))

type Owed = {
  txid: string
  vout: number
  satoshis: number
  payee: string
  derivationPrefix: string
  derivationSuffix: string
  chatRef: boolean
  createdAt: number
}

const ledger = {
  owed: [] as Owed[],
  state: new Map<string, 'pending' | 'delivered' | 'void'>(),
}
const markPaymentNoticeDelivered = vi.fn(async (_active: unknown, txid: string, _vout: number) => {
  if (ledger.state.get(txid) !== 'pending') return false
  ledger.state.set(txid, 'delivered')
  return true
})

vi.mock('./paymentNotice', () => ({
  listPendingPaymentNotices: async () => ledger.owed,
  paymentNoticeStatus: async (_active: unknown, txid: string) => ledger.state.get(txid) ?? 'untracked',
  markPaymentNoticeDelivered: (active: unknown, txid: string, vout: number) =>
    markPaymentNoticeDelivered(active, txid, vout),
}))

vi.mock('./walletRuntime', () => ({
  assertRuntimeCurrent: () => undefined,
  getWalletRuntime: () => null,
}))

vi.mock('./friends', () => ({
  listFriends: () => [{ identityKey: '02' + 'bb'.repeat(32), messagebox: 'https://box.example' }],
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

const savedRows = (): Array<{
  txid: string
  attempts: number
  lastTriedAt?: number
  nextAttemptAt?: number
  lastError?: string
}> => JSON.parse(store.get(KEY) ?? '[]')

const missing = async (): Promise<NotifyResult> => ({ delivered: 'local', beefInBox: false })

beforeEach(async () => {
  store.clear()
  ;(await import('./noticeJournal')).resetNoticeJournalForTests()
  getBeefForTxidCached.mockImplementation(async () => ({ toBinaryAtomic: () => [1, 2, 3] }))
  ledger.owed = []
  ledger.state.clear()
  markPaymentNoticeDelivered.mockClear()
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

  it('never gives up on an owed notice: past the stall mark it is reported, and still retried', async () => {
    store.set(KEY, JSON.stringify([{ ...row(1), attempts: 19 }]))
    notifyPeerBrc29Payment.mockImplementation(missing)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const { flushPendingBrc29Outbox, brc29NoticeDelivery } = await import('./pendingBrc29Outbox')
    await flushPendingBrc29Outbox({ rootKeyHex: ROOT })

    expect(savedRows()).toHaveLength(1)
    expect(savedRows()[0]?.attempts).toBe(20)
    expect(brc29NoticeDelivery(row(1).txid)).toMatchObject({ attempts: 20, stalled: true })
    expect(warn.mock.calls.some(([line]) => String(line).includes('stalled after 20 attempts'))).toBe(true)
    warn.mockRestore()
  })

  it('backs off after a miss: 30 s doubling to an hour, not retried before it is due', async () => {
    const { brc29NoticeRetryDelayMs, flushPendingBrc29Outbox, dueBrc29NoticeCount } =
      await import('./pendingBrc29Outbox')
    expect([1, 2, 3, 8, 9, 40].map(brc29NoticeRetryDelayMs)).toEqual([
      30_000, 60_000, 120_000, 3_600_000, 3_600_000, 3_600_000,
    ])

    store.set(KEY, JSON.stringify([row(1)]))
    notifyPeerBrc29Payment.mockImplementation(missing)
    const before = Date.now()
    await flushPendingBrc29Outbox({ rootKeyHex: ROOT })
    const [kept] = savedRows()
    expect(kept?.nextAttemptAt).toBeGreaterThanOrEqual(before + 30_000)
    expect(kept?.lastError).toBe('Their message box did not take the notice')
    expect(dueBrc29NoticeCount()).toBe(0)

    notifyPeerBrc29Payment.mockClear()
    expect(await flushPendingBrc29Outbox({ rootKeyHex: ROOT })).toBe(0)
    expect(notifyPeerBrc29Payment).not.toHaveBeenCalled()
    expect(dueBrc29NoticeCount(kept!.nextAttemptAt!)).toBe(1)
  })

  it('keeps the reason a delivery threw', async () => {
    store.set(KEY, JSON.stringify([row(1)]))
    notifyPeerBrc29Payment.mockImplementation(async () => {
      throw new Error('box unreachable')
    })
    const { flushPendingBrc29Outbox, brc29NoticeDelivery } = await import('./pendingBrc29Outbox')
    await flushPendingBrc29Outbox({ rootKeyHex: ROOT })
    expect(brc29NoticeDelivery(row(1).txid)).toMatchObject({ attempts: 1, stalled: false, lastError: 'box unreachable' })
  })

  it('does not trim the queue', async () => {
    store.set(KEY, JSON.stringify(Array.from({ length: 80 }, (_, i) => row(i + 1))))
    notifyPeerBrc29Payment.mockImplementation(missing)
    const { flushPendingBrc29Outbox } = await import('./pendingBrc29Outbox')
    await flushPendingBrc29Outbox({ rootKeyHex: ROOT })
    expect(savedRows()).toHaveLength(80)
  })

  it('keeps a row a send queued while the flush was out', async () => {
    store.set(KEY, JSON.stringify([row(1)]))
    const { flushPendingBrc29Outbox, enqueuePendingBrc29Remit } = await import('./pendingBrc29Outbox')
    notifyPeerBrc29Payment.mockImplementation(async () => {
      enqueuePendingBrc29Remit(row(2))
      return { delivered: 'cloud', beefInBox: true }
    })

    expect(await flushPendingBrc29Outbox({ rootKeyHex: ROOT })).toBe(1)
    expect(savedRows().map((r) => r.txid)).toEqual([row(2).txid])
  })

  it('runs one flush at a time, so two callers never post one notice twice', async () => {
    store.set(KEY, JSON.stringify([row(1)]))
    notifyPeerBrc29Payment.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10))
      return { delivered: 'cloud', beefInBox: true }
    })
    const { flushPendingBrc29Outbox } = await import('./pendingBrc29Outbox')

    const [a, b] = await Promise.all([
      flushPendingBrc29Outbox({ rootKeyHex: ROOT }),
      flushPendingBrc29Outbox({ rootKeyHex: ROOT }),
    ])
    expect(a + b).toBe(1)
    expect(notifyPeerBrc29Payment).toHaveBeenCalledTimes(1)
  })

  it('tries one notice now, ignoring its backoff', async () => {
    const later = Date.now() + 3_600_000
    store.set(KEY, JSON.stringify([{ ...row(1), attempts: 7, nextAttemptAt: later }, { ...row(2), nextAttemptAt: later }]))
    const { flushPendingBrc29Outbox } = await import('./pendingBrc29Outbox')

    expect(await flushPendingBrc29Outbox({ rootKeyHex: ROOT, only: row(1).txid })).toBe(1)
    expect(notifyPeerBrc29Payment.mock.calls.map(([a]) => a.txid)).toEqual([row(1).txid])
    expect(savedRows().map((r) => r.txid)).toEqual([row(2).txid])
  })

  it('tells the payment details when the queue changes', async () => {
    store.set(KEY, JSON.stringify([row(1)]))
    notifyPeerBrc29Payment.mockImplementation(missing)
    const { brc29NoticeDelivery, flushPendingBrc29Outbox, subscribeBrc29NoticeQueue } =
      await import('./pendingBrc29Outbox')
    const seen = brc29NoticeDelivery(row(1).txid)
    expect(brc29NoticeDelivery(row(1).txid)).toBe(seen)

    const listener = vi.fn()
    const stop = subscribeBrc29NoticeQueue(listener)
    await flushPendingBrc29Outbox({ rootKeyHex: ROOT })
    stop()
    expect(listener).toHaveBeenCalled()
    expect(brc29NoticeDelivery(row(1).txid)).not.toBe(seen)
    expect(brc29NoticeDelivery(row(2).txid)).toBeNull()
  })
})

describe('the notice ledger behind the queue', () => {
  it('marks the notice delivered when a retry lands', async () => {
    store.set(KEY, JSON.stringify([row(1)]))
    ledger.state.set(row(1).txid, 'pending')
    const { flushPendingBrc29Outbox } = await import('./pendingBrc29Outbox')

    expect(await flushPendingBrc29Outbox({ rootKeyHex: ROOT })).toBe(1)
    expect(markPaymentNoticeDelivered).toHaveBeenCalledWith(expect.anything(), row(1).txid, 0)
    expect(ledger.state.get(row(1).txid)).toBe('delivered')
  })

  it('leaves the notice owed when the retry misses', async () => {
    store.set(KEY, JSON.stringify([row(1)]))
    ledger.state.set(row(1).txid, 'pending')
    notifyPeerBrc29Payment.mockImplementation(async () => ({ delivered: 'local', beefInBox: false }))
    const { flushPendingBrc29Outbox } = await import('./pendingBrc29Outbox')

    await flushPendingBrc29Outbox({ rootKeyHex: ROOT })
    expect(markPaymentNoticeDelivered).not.toHaveBeenCalled()
    expect(ledger.state.get(row(1).txid)).toBe('pending')
  })

  it('drops, unsent, a row whose notice the history already marks delivered', async () => {
    store.set(KEY, JSON.stringify([row(1), row(2)]))
    ledger.state.set(row(2).txid, 'delivered')
    const { flushPendingBrc29Outbox } = await import('./pendingBrc29Outbox')

    expect(await flushPendingBrc29Outbox({ rootKeyHex: ROOT })).toBe(1)
    expect(notifyPeerBrc29Payment.mock.calls.map(([a]) => a.txid)).toEqual([row(1).txid])
    expect(savedRows()).toEqual([])
  })

  it('drops, unsent, a row whose payment failed: nothing is owed for it', async () => {
    store.set(KEY, JSON.stringify([{ ...row(1), attempts: 30 }]))
    ledger.state.set(row(1).txid, 'void')
    const { flushPendingBrc29Outbox } = await import('./pendingBrc29Outbox')

    expect(await flushPendingBrc29Outbox({ rootKeyHex: ROOT })).toBe(0)
    expect(notifyPeerBrc29Payment).not.toHaveBeenCalled()
    expect(savedRows()).toEqual([])
  })

  it('keeps sending a row the records do not name — absence proves nothing was delivered', async () => {
    store.set(KEY, JSON.stringify([row(1)]))
    notifyPeerBrc29Payment.mockImplementation(missing)
    const { flushPendingBrc29Outbox } = await import('./pendingBrc29Outbox')

    await flushPendingBrc29Outbox({ rootKeyHex: ROOT })
    expect(notifyPeerBrc29Payment).toHaveBeenCalledTimes(1)
    expect(savedRows()).toHaveLength(1)
  })

  it('re-sends an in-thread payment as an in-thread card', async () => {
    store.set(KEY, JSON.stringify([{ ...row(1), chatRef: true }]))
    const { flushPendingBrc29Outbox } = await import('./pendingBrc29Outbox')

    await flushPendingBrc29Outbox({ rootKeyHex: ROOT })
    expect(notifyPeerBrc29Payment).toHaveBeenCalledWith(expect.objectContaining({ chatRef: true }))
  })
})

describe('reopenOwedBrc29Notices', () => {
  const SENDER = '03' + 'aa'.repeat(32)
  const runtime = {
    instance: { accountIndex: 0, identityKey: SENDER, chain: 'main', rootKeyHex: ROOT },
    signal: new AbortController().signal,
  }
  const owedFor = (n: number, chatRef = false): Owed => ({
    txid: row(n).txid,
    vout: 0,
    satoshis: 100 + n,
    payee: row(n).payeeIdentityKey,
    derivationPrefix: 'pre',
    derivationSuffix: 'suf',
    chatRef,
    createdAt: 1_000 + n,
  })
  const scopedRows = async () => {
    const { accountLocalKeyFor } = await import('./accountLocalKeys')
    const key = accountLocalKeyFor(KEY, { accountIndex: 0, identityKey: SENDER, chain: 'main' })
    return JSON.parse(store.get(key) ?? '[]') as Array<Record<string, unknown>>
  }

  it('queues what the history owes, with the payee box, and nothing twice', async () => {
    ledger.owed = [owedFor(1), owedFor(2, true)]
    const { reopenOwedBrc29Notices } = await import('./pendingBrc29Outbox')
    const reopen = () => reopenOwedBrc29Notices(runtime as never)

    expect(await reopen()).toBe(2)
    expect(await reopen()).toBe(0)
    const rows = await scopedRows()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      txid: row(1).txid,
      senderIdentityKey: SENDER,
      satoshis: 101,
      remittance: { derivationPrefix: 'pre', derivationSuffix: 'suf', outputIndex: 0 },
      messagebox: 'https://box.example',
      attempts: 0,
    })
    expect(rows[1]).toMatchObject({ txid: row(2).txid, chatRef: true })
  })

  it('keeps the attempts of a row already queued', async () => {
    const { reopenOwedBrc29Notices, enqueuePendingBrc29Remit } = await import('./pendingBrc29Outbox')
    enqueuePendingBrc29Remit({ ...row(1), attempts: 4 }, runtime.instance as never)
    ledger.owed = [owedFor(1)]

    expect(await reopenOwedBrc29Notices(runtime as never)).toBe(0)
    expect((await scopedRows())[0]?.attempts).toBe(4)
  })

  it('owes nothing when the history owes nothing', async () => {
    const { reopenOwedBrc29Notices } = await import('./pendingBrc29Outbox')
    expect(await reopenOwedBrc29Notices(runtime as never)).toBe(0)
    expect(await scopedRows()).toEqual([])
  })

  it('queues a notice the journal owes that the restored history does not have', async () => {
    const { journalOwedNotice } = await import('./noticeJournal')
    journalOwedNotice(runtime.instance, {
      txid: row(3).txid,
      vout: 0,
      satoshis: 103,
      payee: row(3).payeeIdentityKey,
      derivationPrefix: 'pre',
      derivationSuffix: 'suf',
      chatRef: true,
    })
    ledger.owed = [owedFor(1), owedFor(3)]
    const { reopenOwedBrc29Notices } = await import('./pendingBrc29Outbox')

    expect(await reopenOwedBrc29Notices(runtime as never)).toBe(2)
    expect((await scopedRows()).map((r) => r.txid)).toEqual([row(1).txid, row(3).txid])

    ledger.owed = []
    store.clear()
    expect(await reopenOwedBrc29Notices(runtime as never)).toBe(1)
    expect(await scopedRows()).toEqual([
      expect.objectContaining({ txid: row(3).txid, satoshis: 103, chatRef: true, messagebox: 'https://box.example' }),
    ])
  })

  it('hands the payee the journaled BEEF when this device no longer holds the payment', async () => {
    const { journalOwedNotice, owedJournalNotices } = await import('./noticeJournal')
    journalOwedNotice(runtime.instance, {
      txid: row(1).txid,
      vout: 0,
      satoshis: 101,
      payee: row(1).payeeIdentityKey,
      derivationPrefix: 'pre',
      derivationSuffix: 'suf',
      atomicBeef: [9, 8, 7],
    })
    getBeefForTxidCached.mockImplementation(async () => {
      throw new Error('not in this wallet')
    })
    const { reopenOwedBrc29Notices, flushPendingBrc29Outbox } = await import('./pendingBrc29Outbox')
    await reopenOwedBrc29Notices(runtime as never)

    expect(await flushPendingBrc29Outbox({ rootKeyHex: ROOT, runtime: runtime as never })).toBe(1)
    expect(notifyPeerBrc29Payment).toHaveBeenCalledWith(expect.objectContaining({ atomicBeef: [9, 8, 7] }))
    expect(owedJournalNotices(runtime.instance as never)).toEqual([])
  })

  it('settles the journal when the records already say delivered', async () => {
    const { journalOwedNotice, owedJournalNotices } = await import('./noticeJournal')
    journalOwedNotice(runtime.instance, {
      txid: row(1).txid,
      vout: 0,
      satoshis: 101,
      payee: row(1).payeeIdentityKey,
      derivationPrefix: 'pre',
      derivationSuffix: 'suf',
    })
    ledger.state.set(row(1).txid, 'delivered')
    const { reopenOwedBrc29Notices, flushPendingBrc29Outbox } = await import('./pendingBrc29Outbox')
    await reopenOwedBrc29Notices(runtime as never)

    expect(await flushPendingBrc29Outbox({ rootKeyHex: ROOT, runtime: runtime as never })).toBe(0)
    expect(notifyPeerBrc29Payment).not.toHaveBeenCalled()
    expect(owedJournalNotices(runtime.instance as never)).toEqual([])
  })

  it('a flush re-reads the records at most every ten minutes, so a lost row comes back', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 60 * 60_000)
      const { flushPendingBrc29Outbox } = await import('./pendingBrc29Outbox')
      const flush = () => flushPendingBrc29Outbox({ rootKeyHex: ROOT, runtime: runtime as never })
      notifyPeerBrc29Payment.mockImplementation(missing)

      ledger.owed = [owedFor(1)]
      await flush()
      expect((await scopedRows()).map((r) => r.txid)).toEqual([row(1).txid])

      ledger.owed = [owedFor(1), owedFor(2)]
      await flush()
      expect(await scopedRows()).toHaveLength(1)

      vi.setSystemTime(Date.now() + 10 * 60_000)
      await flush()
      expect((await scopedRows()).map((r) => r.txid)).toEqual([row(1).txid, row(2).txid])
    } finally {
      vi.useRealTimers()
    }
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
