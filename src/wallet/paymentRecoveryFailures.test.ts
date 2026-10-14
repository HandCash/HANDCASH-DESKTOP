/**
 * Failure injection across the BRC-29 notice path: the notice journal, the
 * outbox, and the restore reconcile run for real; the disk, the backup host,
 * the payee's message box and the wallet's records are simulated so a crash,
 * a lost acknowledgement, a lost device or two recoveries at once can be
 * forced at the exact step that matters.
 *
 * A device is a disk plus a module graph: `on(device)` drops every in-memory
 * state (a restart) and keeps only what that device persisted.
 */
import { PrivateKey } from '@bsv/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

type Device = {
  store: Map<string, string>
  ledger: Map<string, { notice: Owed; state: 'pending' | 'delivered' }>
  activity: Set<string>
  beefs: Map<string, number[]>
  failMark: boolean
  active: { identityKey: string; accountIndex: number; chain: 'main'; rootKeyHex: string }
  runtime: { runtimeId: string; instance: Device['active']; signal: AbortSignal }
}

type Delivered = { txid: string; vout: number; derivationPrefix: string; atomicBeef?: number[] }

const env = vi.hoisted(() => ({
  device: null as unknown as Device,
  box: 'ok' as 'ok' | 'down' | 'ackLost',
  miner: 'accept' as 'accept' | 'reject',
  /** When set, the miner answers only once this settles. */
  verdict: null as Promise<void> | null,
  /** Payments whose inputs a device sealed, in order, with what had happened before. */
  sealed: [] as string[],
  inbox: [] as Delivered[],
  host: { body: null as string | null, etag: 0, down: false },
}))

vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => env.device.store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    env.device.store.set(key, value)
    return true
  },
}))

/** One backup object with R2-style conditional writes, shared by every device. */
vi.mock('./identityRequestAuth', () => ({
  signedIdentityFetch: async (_root: string, _scope: string, _url: string, init: RequestInit = {}) => {
    const { host } = env
    if (host.down) throw new TypeError('Failed to fetch')
    if (init.method === 'PUT') {
      const match = new Headers(init.headers).get('If-Match')
      if (match && match !== `"${host.etag}"`) return new Response('{}', { status: 412 })
      if (!match && host.body != null) return new Response('{}', { status: 409 })
      host.body = String(init.body)
      host.etag += 1
      return Response.json({ ok: true, etag: `"${host.etag}"` })
    }
    if (host.body == null) return new Response('{}', { status: 404 })
    return new Response(host.body, { status: 200, headers: { ETag: `"${host.etag}"` } })
  },
}))
vi.mock('./historyBackupPrefs', () => ({ resolveHistoryBackupBaseUrl: () => 'https://box.test' }))

vi.mock('./walletRuntime', () => ({
  assertRuntimeCurrent: () => undefined,
  getWalletRuntime: () => env.device.runtime,
}))
vi.mock('./session', () => ({ getActiveWallet: () => env.device.active }))

vi.mock('./paymentNotice', () => ({
  listPendingPaymentNotices: async () =>
    [...env.device.ledger.values()].filter((r) => r.state === 'pending').map((r) => r.notice),
  paymentNoticeStatus: async (_active: unknown, txid: string) => env.device.ledger.get(txid)?.state ?? 'untracked',
  markPaymentNoticeDelivered: async (_active: unknown, txid: string) => {
    if (env.device.failMark) throw new Error('QuotaExceededError')
    const record = env.device.ledger.get(txid)
    if (record?.state !== 'pending') return false
    record.state = 'delivered'
    return true
  },
}))

vi.mock('./beefCache', () => ({
  getBeefForTxidCached: async (_active: unknown, txid: string) => {
    const beef = env.device.beefs.get(txid)
    if (!beef) throw new Error('transaction not in this wallet')
    return { toBinaryAtomic: () => beef }
  },
}))

vi.mock('./messageTransport', () => ({
  notifyPeerBrc29Payment: async (args: {
    txid: string
    remittance: { derivationPrefix: string; outputIndex?: number }
    atomicBeef?: number[]
  }) => {
    if (env.box === 'down') throw new Error('Failed to fetch')
    env.inbox.push({
      txid: args.txid,
      vout: args.remittance.outputIndex ?? 0,
      derivationPrefix: args.remittance.derivationPrefix,
      atomicBeef: args.atomicBeef,
    })
    if (env.box === 'ackLost') throw new Error('The network connection was lost')
    return { delivered: 'cloud', beefInBox: true }
  },
}))

/** The signed-send lifecycle: sealing holds the cheque on this device; the miner decides its fate. */
vi.mock('./signedSendLifecycle', () => ({
  registerSignedSend: async (args: { txid: string; atomicBeef: number[] }) => {
    env.sealed.push(args.txid)
    env.device.beefs.set(args.txid, args.atomicBeef)
    return { txid: args.txid }
  },
  propagateSignedSend: async () => {
    await env.verdict
    if (env.miner === 'reject') throw new Error('Arcade: double spend')
    return { kind: 'accepted' }
  },
}))
vi.mock('./legacyScan', () => ({ txExistsOnChain: async () => null }))

vi.mock('./friends', () => ({ listFriends: () => [] }))
vi.mock('./appActivity', () => ({
  WALLET_ACTIVITY_ORIGIN: 'handcash',
  hasActivityTxid: (txid: string) => env.device.activity.has(txid),
  upsertAppActivity: (args: { txid: string }) => env.device.activity.add(args.txid),
  formatActivityRecipientDisplay: ({ to }: { to: string }) => to.slice(0, 8),
}))

const ROOT = PrivateKey.fromRandom()
const IDENTITY = ROOT.toPublicKey().toString()
const PAYEE = PrivateKey.fromRandom().toPublicKey().toString()
const txid = (n: number) => n.toString(16).padStart(2, '0').repeat(32)
const beef = (n: number) => [0xbe, 0xef, n]

function payment(n: number): Owed {
  return {
    txid: txid(n),
    vout: 0,
    satoshis: 1_000 + n,
    payee: PAYEE,
    derivationPrefix: `pre${n}`,
    derivationSuffix: 'suf',
    chatRef: false,
    createdAt: 1,
  }
}

let devices = 0
function device(): Device {
  const active = { identityKey: IDENTITY, accountIndex: 0, chain: 'main' as const, rootKeyHex: ROOT.toHex() }
  devices += 1
  return {
    store: new Map(),
    ledger: new Map(),
    activity: new Set(),
    beefs: new Map(),
    failMark: false,
    active,
    runtime: { runtimeId: `rt-${devices}`, instance: active, signal: new AbortController().signal },
  }
}

/** The payee keeps one card per payment output, however many notices arrive. */
const cards = () => new Set(env.inbox.map((n) => `${n.txid}.${n.vout}`)).size

type Wallet = {
  journal: typeof import('./noticeJournal')
  outbox: typeof import('./pendingBrc29Outbox')
  reconcile: typeof import('./paymentReconcile')
}
let live: Wallet | null = null

/** Run as `dev` from a cold start: only its disk survives. */
async function on(dev: Device): Promise<Wallet> {
  live?.journal.resetNoticeJournalForTests()
  live?.reconcile.resetPaymentReconcileForTests()
  env.device = dev
  vi.resetModules()
  live = {
    journal: await import('./noticeJournal'),
    outbox: await import('./pendingBrc29Outbox'),
    reconcile: await import('./paymentReconcile'),
  }
  return live
}

/** What `sendBrc29Payment` writes once the payment is sealed, before it propagates. */
function sealPayment(w: Wallet, dev: Device, n: number, opts: { recorded: boolean }): void {
  w.journal.journalOwedNotice(dev.active, { ...payment(n), atomicBeef: beef(n) })
  if (opts.recorded) {
    dev.ledger.set(txid(n), { notice: payment(n), state: 'pending' })
    dev.beefs.set(txid(n), beef(n))
  }
}

function queueNotice(w: Wallet, dev: Device, n: number): void {
  w.outbox.enqueuePendingBrc29Remit(
    {
      payeeIdentityKey: PAYEE,
      senderIdentityKey: IDENTITY,
      txid: txid(n),
      satoshis: 1_000 + n,
      remittance: { derivationPrefix: `pre${n}`, derivationSuffix: 'suf', outputIndex: 0 },
    },
    dev.active,
  )
}

const flush = (w: Wallet, dev: Device) =>
  w.outbox.flushPendingBrc29Outbox({ rootKeyHex: dev.active.rootKeyHex, runtime: dev.runtime as never })

beforeEach(() => {
  env.box = 'ok'
  env.miner = 'accept'
  env.verdict = null
  env.sealed = []
  env.inbox = []
  env.host = { body: null, etag: 0, down: false }
  live = null
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  live?.journal.resetNoticeJournalForTests()
  live?.reconcile.resetPaymentReconcileForTests()
  vi.restoreAllMocks()
})

describe('app killed between signing and broadcast', () => {
  it('delivers the notice with the journaled transaction after a restart', async () => {
    const phone = device()
    let w = await on(phone)
    sealPayment(w, phone, 1, { recorded: false })
    // Killed here: the record never committed, no queue row, nothing reached the host.
    expect(env.host.body).toBeNull()

    w = await on(phone)
    await w.outbox.deliverOwedBrc29Notices(phone.runtime as never)

    expect(env.inbox).toEqual([expect.objectContaining({ txid: txid(1), atomicBeef: beef(1) })])
    expect(w.journal.owedJournalNotices(phone.active)).toEqual([])
    expect(w.outbox.owedBrc29NoticeRows(phone.active)).toEqual([])
  })

  it('keeps the notice owed while the payee box is down, and delivers it later', async () => {
    const phone = device()
    let w = await on(phone)
    sealPayment(w, phone, 2, { recorded: false })

    env.box = 'down'
    w = await on(phone)
    await w.outbox.deliverOwedBrc29Notices(phone.runtime as never)
    expect(w.outbox.owedBrc29NoticeRows(phone.active)).toEqual([
      expect.objectContaining({ txid: txid(2), attempts: 1, lastError: 'Failed to fetch' }),
    ])

    env.box = 'ok'
    w = await on(phone)
    expect(await w.outbox.retryBrc29NoticeNow(phone.runtime as never, txid(2))).toBe(true)
    expect(env.inbox).toEqual([expect.objectContaining({ txid: txid(2), atomicBeef: beef(2) })])
  })
})

describe('lost acknowledgement', () => {
  it('repeats the same notice for the same payment, never a second payment', async () => {
    const phone = device()
    const w = await on(phone)
    sealPayment(w, phone, 3, { recorded: true })
    queueNotice(w, phone, 3)

    env.box = 'ackLost'
    expect(await flush(w, phone)).toBe(0)
    expect(w.outbox.owedBrc29NoticeRows(phone.active)).toEqual([
      expect.objectContaining({ attempts: 1, lastError: 'The network connection was lost' }),
    ])

    env.box = 'ok'
    expect(await w.outbox.retryBrc29NoticeNow(phone.runtime as never, txid(3))).toBe(true)
    expect(env.inbox).toHaveLength(2)
    expect(new Set(env.inbox.map((n) => `${n.txid}:${n.derivationPrefix}`))).toEqual(new Set([`${txid(3)}:pre3`]))
    expect(cards()).toBe(1)
    expect(phone.ledger.get(txid(3))?.state).toBe('delivered')
  })

  it('a delivery the record could not store is settled by the journal, not sent again', async () => {
    const phone = device()
    const w = await on(phone)
    sealPayment(w, phone, 4, { recorded: true })
    queueNotice(w, phone, 4)

    phone.failMark = true
    expect(await flush(w, phone)).toBe(1)
    expect(phone.ledger.get(txid(4))?.state).toBe('pending')

    phone.failMark = false
    expect(await w.outbox.reopenOwedBrc29Notices(phone.runtime as never)).toBe(1)
    expect(await flush(w, phone)).toBe(0)

    expect(env.inbox).toHaveLength(1)
    expect(phone.ledger.get(txid(4))?.state).toBe('delivered')
    expect(w.outbox.owedBrc29NoticeRows(phone.active)).toEqual([])
  })
})

describe('device lost before the notice went out', () => {
  it('a restored device resumes the lost payment before the next one, relists it, and notifies the payee', async () => {
    const lost = device()
    let w = await on(lost)
    sealPayment(w, lost, 5, { recorded: true })
    env.box = 'down'
    await w.journal.syncNoticeJournal(lost.active as never, 'grew')

    // The history backup predates the payment: no record, no transaction, no Activity row.
    env.box = 'ok'
    const fresh = device()
    w = await on(fresh)
    void w.reconcile.reconcilePaymentsAfterRestore(fresh.runtime as never)
    expect(await w.reconcile.awaitPaymentReconcile(fresh.runtime as never)).toMatchObject({ kind: 'reconciled' })
    // Its inputs are sealed before the next payment may select any.
    expect(env.sealed).toEqual([txid(5)])
    expect(fresh.activity.has(txid(5))).toBe(true)

    await vi.waitFor(() => expect(env.inbox).toHaveLength(1))
    expect(env.inbox[0]).toMatchObject({ txid: txid(5), derivationPrefix: 'pre5', atomicBeef: beef(5) })
    await vi.waitFor(() => expect(w.outbox.owedBrc29NoticeRows(fresh.active)).toEqual([]))

    await w.journal.syncNoticeJournal(fresh.active as never, 'grew')
    const third = device()
    w = await on(third)
    await w.journal.syncNoticeJournal(third.active as never, 'recover')
    expect(w.journal.owedJournalNotices(third.active)).toEqual([])
  })

  it('a lost payment the miners prove dead is never announced to the payee', async () => {
    const lost = device()
    let w = await on(lost)
    sealPayment(w, lost, 11, { recorded: true })
    await w.journal.syncNoticeJournal(lost.active as never, 'grew')

    env.miner = 'reject'
    let answer!: () => void
    env.verdict = new Promise<void>((resolve) => {
      answer = resolve
    })
    const fresh = device()
    w = await on(fresh)
    await w.reconcile.reconcilePaymentsAfterRestore(fresh.runtime as never)
    // The Dashboard's notice tick fires while the miners have not answered yet.
    expect(await flush(w, fresh)).toBe(0)
    expect(env.inbox).toEqual([])

    answer()
    await vi.waitFor(() => expect(w.journal.noticeJournalSettled(fresh.active, txid(11), 0)).toBe(true))
    await vi.waitFor(() => expect(w.outbox.owedBrc29NoticeRows(fresh.active)).toEqual([]))

    expect(env.sealed).toEqual([txid(11)])
    expect(env.inbox).toEqual([])
  })

  it('a backup host that is down neither blocks the next payment nor loses the record', async () => {
    const fresh = device()
    fresh.ledger.set(txid(6), { notice: payment(6), state: 'pending' })
    fresh.beefs.set(txid(6), beef(6))
    env.host.down = true
    const w = await on(fresh)

    await w.reconcile.reconcilePaymentsAfterRestore(fresh.runtime as never)
    expect(await w.reconcile.awaitPaymentReconcile(fresh.runtime as never)).toEqual({ kind: 'clear' })
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[notice-journal] backup recover failed'))
    await vi.waitFor(() => expect(env.inbox.map((n) => n.txid)).toEqual([txid(6)]))
  })
})

describe('two recoveries at once', () => {
  it('on one device: every owed notice goes out exactly once', async () => {
    const lost = device()
    let w = await on(lost)
    sealPayment(w, lost, 7, { recorded: true })
    sealPayment(w, lost, 8, { recorded: true })
    await w.journal.syncNoticeJournal(lost.active as never, 'grew')

    // The restored history has payment 7 but not 8.
    const fresh = device()
    fresh.ledger.set(txid(7), { notice: payment(7), state: 'pending' })
    fresh.beefs.set(txid(7), beef(7))
    w = await on(fresh)
    const rt = fresh.runtime as never
    await Promise.all([
      w.reconcile.reconcilePaymentsAfterRestore(rt),
      w.outbox.deliverOwedBrc29Notices(rt),
      w.outbox.deliverOwedBrc29Notices(rt),
    ])
    await vi.waitFor(() => expect(w.outbox.owedBrc29NoticeRows(fresh.active)).toEqual([]))
    await flush(w, fresh)

    expect(env.inbox.map((n) => n.txid).sort()).toEqual([txid(7), txid(8)])
    expect(env.inbox.find((n) => n.txid === txid(8))?.atomicBeef).toEqual(beef(8))
  })

  it('on two devices: the second drops a notice the first already delivered', async () => {
    const lost = device()
    let w = await on(lost)
    sealPayment(w, lost, 9, { recorded: true })
    await w.journal.syncNoticeJournal(lost.active as never, 'grew')

    const b = device()
    const c = device()
    for (const dev of [b, c]) {
      w = await on(dev)
      await w.journal.syncNoticeJournal(dev.active as never, 'recover')
      expect(await w.outbox.reopenOwedBrc29Notices(dev.runtime as never)).toBe(1)
    }

    w = await on(b)
    expect(await flush(w, b)).toBe(1)
    await w.journal.syncNoticeJournal(b.active as never, 'grew')

    w = await on(c)
    await w.journal.syncNoticeJournal(c.active as never, 'recover')
    expect(await flush(w, c)).toBe(0)

    expect(env.inbox).toHaveLength(1)
    expect(w.outbox.owedBrc29NoticeRows(c.active)).toEqual([])
  })

  it('on two devices racing blind: at worst one repeated notice, one card, and both settle', async () => {
    const lost = device()
    let w = await on(lost)
    sealPayment(w, lost, 10, { recorded: true })
    await w.journal.syncNoticeJournal(lost.active as never, 'grew')

    const b = device()
    const c = device()
    for (const dev of [b, c]) {
      w = await on(dev)
      await w.outbox.deliverOwedBrc29Notices(dev.runtime as never)
    }
    for (const dev of [b, c]) {
      w = await on(dev)
      await w.journal.syncNoticeJournal(dev.active as never, 'grew')
    }

    expect(env.inbox.length).toBeLessThanOrEqual(2)
    expect(cards()).toBe(1)
    for (const dev of [b, c]) {
      w = await on(dev)
      await w.journal.syncNoticeJournal(dev.active as never, 'recover')
      expect(w.journal.owedJournalNotices(dev.active)).toEqual([])
      expect(w.outbox.owedBrc29NoticeRows(dev.active)).toEqual([])
    }
  })
})
