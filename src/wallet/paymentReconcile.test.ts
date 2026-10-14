import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WalletRuntime } from './walletRuntime'

const journal = vi.hoisted(() => ({ sync: vi.fn(), beef: vi.fn(), done: vi.fn() }))
const outbox = vi.hoisted(() => ({ reopen: vi.fn(), rows: vi.fn(), flush: vi.fn(), held: new Set<string>() }))
const activity = vi.hoisted(() => ({ listed: new Set<string>(), upsert: vi.fn() }))
const runtimes = vi.hoisted(() => ({ current: true }))
const records = vi.hoisted(() => ({ status: vi.fn() }))
const chain = vi.hoisted(() => ({ exists: vi.fn() }))
const lifecycle = vi.hoisted(() => ({ register: vi.fn(), propagate: vi.fn() }))

vi.mock('./accountLocalKeys', () => ({ accountKeyScopeFor: () => 'acct-0' }))
vi.mock('./noticeJournal', () => ({
  syncNoticeJournal: journal.sync,
  noticeJournalBeef: journal.beef,
  journalNoticeDone: journal.done,
}))
vi.mock('./paymentNotice', () => ({ paymentNoticeStatus: records.status }))
vi.mock('./legacyScan', () => ({ txExistsOnChain: chain.exists }))
vi.mock('./signedSendLifecycle', () => ({
  registerSignedSend: lifecycle.register,
  propagateSignedSend: lifecycle.propagate,
}))
vi.mock('./pendingBrc29Outbox', () => ({
  reopenOwedBrc29Notices: outbox.reopen,
  owedBrc29NoticeRows: outbox.rows,
  flushPendingBrc29Outbox: outbox.flush,
  holdBrc29NoticeForVerdict: (txid: string) => {
    outbox.held.add(txid)
    return () => outbox.held.delete(txid)
  },
}))
vi.mock('./walletRuntime', () => ({
  assertRuntimeCurrent: () => {
    if (!runtimes.current) throw new DOMException('Wallet runtime disposed', 'AbortError')
  },
}))
vi.mock('./appActivity', () => ({
  WALLET_ACTIVITY_ORIGIN: 'handcash',
  hasActivityTxid: (txid: string) => activity.listed.has(txid),
  upsertAppActivity: activity.upsert,
  formatActivityRecipientDisplay: ({ friendLabel, to }: { friendLabel?: string; to: string }) =>
    friendLabel ?? to.slice(0, 8),
}))
vi.mock('./friends', () => ({
  listFriends: () => [{ identityKey: 'AA'.repeat(33), label: '$alice' }],
}))

import {
  awaitPaymentReconcile,
  reconcilePaymentsAfterRestore,
  resetPaymentReconcileForTests,
} from './paymentReconcile'

const runtime = (id = 'rt-1') =>
  ({ runtimeId: id, instance: { rootKeyHex: 'ab'.repeat(32), chain: 'main' } }) as unknown as WalletRuntime

const owedRow = (txid: string, payee = 'aa'.repeat(33)) => ({
  txid,
  satoshis: 1_500,
  payeeIdentityKey: payee,
  senderIdentityKey: '03' + 'cc'.repeat(32),
  remittance: { derivationPrefix: 'p', derivationSuffix: 's', outputIndex: 0 },
  createdAt: 1,
  attempts: 0,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  resetPaymentReconcileForTests()
  runtimes.current = true
  activity.listed.clear()
  activity.upsert.mockReset()
  journal.sync.mockReset().mockResolvedValue({ kind: 'synced' })
  outbox.reopen.mockReset().mockResolvedValue(0)
  outbox.rows.mockReset().mockReturnValue([])
  outbox.flush.mockReset().mockResolvedValue(0)
  outbox.held.clear()
  journal.beef.mockReset().mockReturnValue(null)
  journal.done.mockReset()
  records.status.mockReset().mockResolvedValue('pending')
  chain.exists.mockReset().mockResolvedValue(null)
  lifecycle.register.mockReset().mockImplementation(async (args: { txid: string }) => ({ txid: args.txid }))
  lifecycle.propagate.mockReset().mockResolvedValue({ kind: 'accepted' })
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('awaitPaymentReconcile', () => {
  it('does not hold a payment when no restore ran', async () => {
    await expect(awaitPaymentReconcile(runtime())).resolves.toEqual({ kind: 'clear' })
  })

  it('holds the next payment until the restore reconcile finishes', async () => {
    const pulled = deferred<{ kind: string }>()
    journal.sync.mockReturnValue(pulled.promise)
    const rt = runtime()
    void reconcilePaymentsAfterRestore(rt)

    let held: unknown = null
    const waiting = awaitPaymentReconcile(rt).then((h) => {
      held = h
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(held).toBeNull()

    pulled.resolve({ kind: 'synced' })
    await waiting
    expect(held).toMatchObject({ kind: 'reconciled' })
    await expect(awaitPaymentReconcile(rt)).resolves.toEqual({ kind: 'clear' })
  })

  it('sends anyway when the reconcile cannot finish in time', async () => {
    vi.useFakeTimers()
    journal.sync.mockReturnValue(new Promise(() => {}))
    const rt = runtime()
    void reconcilePaymentsAfterRestore(rt)

    const waiting = awaitPaymentReconcile(rt, 20_000)
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(waiting).resolves.toMatchObject({ kind: 'timedOut' })
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('sending anyway'))
  })

  it("does not hold another account's payment", async () => {
    journal.sync.mockReturnValue(new Promise(() => {}))
    void reconcilePaymentsAfterRestore(runtime('rt-1'))
    await expect(awaitPaymentReconcile(runtime('rt-2'))).resolves.toEqual({ kind: 'clear' })
    await expect(awaitPaymentReconcile(null)).resolves.toEqual({ kind: 'clear' })
  })
})

describe('reconcilePaymentsAfterRestore', () => {
  it('pulls the journal, re-queues owed notices, then delivers them', async () => {
    const order: string[] = []
    journal.sync.mockImplementation(async () => {
      order.push('journal')
      return { kind: 'synced' }
    })
    outbox.reopen.mockImplementation(async () => {
      order.push('reopen')
      return 2
    })
    outbox.flush.mockImplementation(async () => {
      order.push('flush')
      return 0
    })

    const rt = runtime()
    await reconcilePaymentsAfterRestore(rt)
    await vi.waitFor(() => expect(outbox.flush).toHaveBeenCalled())

    expect(journal.sync).toHaveBeenCalledWith(rt.instance, 'recover')
    expect(order).toEqual(['journal', 'reopen', 'flush'])
    expect(outbox.flush).toHaveBeenCalledWith({ rootKeyHex: rt.instance.rootKeyHex, runtime: rt })
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('2 notice(s) queued'))
  })

  it('lists in Activity a payment the records hold but Activity lost', async () => {
    activity.listed.add('kept'.padEnd(64, '0'))
    outbox.rows.mockReturnValue([owedRow('kept'.padEnd(64, '0')), owedRow('lost'.padEnd(64, '0'))])

    await reconcilePaymentsAfterRestore(runtime())

    expect(activity.upsert).toHaveBeenCalledTimes(1)
    expect(activity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'spent',
        sats: 1_500,
        txid: 'lost'.padEnd(64, '0'),
        note: 'Sent to $alice',
        status: 'complete',
      }),
      'acct-0',
    )
    expect(lifecycle.register).not.toHaveBeenCalled()
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('1 payment(s) relisted, 0 resumed'))
  })

  it('resumes a journaled payment the restored history lacks: sealed before the hold lifts, then propagated', async () => {
    const txid = 'a1'.repeat(32)
    outbox.rows.mockReturnValue([owedRow(txid)])
    records.status.mockResolvedValue('untracked')
    journal.beef.mockReturnValue([0xbe, 0xef])
    const order: string[] = []
    lifecycle.register.mockImplementation(async () => {
      order.push('sealed')
      return { txid }
    })
    lifecycle.propagate.mockImplementation(async () => {
      order.push(outbox.held.has(txid) ? 'propagated (notice held)' : 'propagated')
      return { kind: 'accepted' }
    })
    outbox.flush.mockImplementation(async () => {
      order.push(outbox.held.has(txid) ? 'notified while held' : 'notified')
      return 1
    })

    const rt = runtime()
    void reconcilePaymentsAfterRestore(rt)
    await awaitPaymentReconcile(rt)
    order.push('next payment')
    await vi.waitFor(() => expect(outbox.flush).toHaveBeenCalled())

    expect(lifecycle.register).toHaveBeenCalledWith({
      txid,
      atomicBeef: [0xbe, 0xef],
      flow: 'brc29',
      satoshis: 1_500,
      to: 'aa'.repeat(33),
    })
    expect(order[0]).toBe('sealed')
    expect(order).toContain('propagated (notice held)')
    expect(order.indexOf('propagated (notice held)')).toBeLessThan(order.indexOf('notified'))
    expect(outbox.held.size).toBe(0)
    expect(activity.upsert).toHaveBeenCalledWith(expect.objectContaining({ txid, status: 'complete' }), 'acct-0')
    expect(journal.done).not.toHaveBeenCalled()
  })

  it('a resumed payment the miners prove dead settles its notice before any could be sent', async () => {
    const txid = 'a2'.repeat(32)
    outbox.rows.mockReturnValue([owedRow(txid)])
    records.status.mockResolvedValue('untracked')
    journal.beef.mockReturnValue([0xbe, 0xef])
    lifecycle.propagate.mockRejectedValue(new Error('double spend'))
    const order: string[] = []
    journal.done.mockImplementation(() => void order.push('settled'))
    outbox.flush.mockImplementation(async () => {
      order.push('flush')
      return 0
    })

    await reconcilePaymentsAfterRestore(runtime())
    await vi.waitFor(() => expect(outbox.flush).toHaveBeenCalled())

    expect(journal.done).toHaveBeenCalledWith('acct-0', txid, 0)
    expect(order).toEqual(['settled', 'flush'])
  })

  it('without a journaled transaction, only the chain can vouch: pending until seen', async () => {
    const unseen = 'a3'.repeat(32)
    const seen = 'a4'.repeat(32)
    outbox.rows.mockReturnValue([owedRow(unseen), owedRow(seen)])
    records.status.mockResolvedValue('untracked')
    chain.exists.mockImplementation(async (txid: string) => (txid === seen ? true : null))

    await reconcilePaymentsAfterRestore(runtime())

    expect(lifecycle.register).not.toHaveBeenCalled()
    expect(activity.upsert).toHaveBeenCalledWith(expect.objectContaining({ txid: unseen, status: 'pending' }), 'acct-0')
    expect(activity.upsert).toHaveBeenCalledWith(expect.objectContaining({ txid: seen, status: 'complete' }), 'acct-0')
  })

  it('never throws and releases the hold when the backup host is down', async () => {
    journal.sync.mockRejectedValue(new Error('host unreachable'))
    const rt = runtime()
    await expect(reconcilePaymentsAfterRestore(rt)).resolves.toBeUndefined()
    await expect(awaitPaymentReconcile(rt)).resolves.toEqual({ kind: 'clear' })
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('restore incomplete'),
      'host unreachable',
    )
  })

  it('stops when the account changed mid-reconcile', async () => {
    journal.sync.mockImplementation(async () => {
      runtimes.current = false
      return { kind: 'synced' }
    })
    await reconcilePaymentsAfterRestore(runtime())
    expect(outbox.reopen).not.toHaveBeenCalled()
    expect(activity.upsert).not.toHaveBeenCalled()
  })
})
