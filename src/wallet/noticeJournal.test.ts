import { PrivateKey } from '@bsv/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
vi.mock('./durableStorage', () => ({
  durableGetItem: (key: string) => store.get(key) ?? null,
  durableSetItem: (key: string, value: string) => {
    store.set(key, value)
    return true
  },
}))

/** One object with R2-style conditional writes. */
const host = { body: null as string | null, etag: 0, puts: 0 }
vi.mock('./identityRequestAuth', () => ({
  signedIdentityFetch: async (_root: string, _scope: string, _url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (init.method === 'PUT') {
      const match = headers.get('If-Match')
      if (match && match !== `"${host.etag}"`) return new Response('{}', { status: 412 })
      if (!match && host.body != null) return new Response('{}', { status: 409 })
      host.body = String(init.body)
      host.etag += 1
      host.puts += 1
      return Response.json({ ok: true, etag: `"${host.etag}"` })
    }
    if (host.body == null) return new Response('{}', { status: 404 })
    return new Response(host.body, { status: 200, headers: { ETag: `"${host.etag}"` } })
  },
}))
vi.mock('./historyBackupPrefs', () => ({ resolveHistoryBackupBaseUrl: () => 'https://box.test' }))

const root = PrivateKey.fromRandom()
const identityKey = root.toPublicKey().toString()
const active = { identityKey, accountIndex: 0, chain: 'main' as const, rootKeyHex: root.toHex() }
vi.mock('./walletRuntime', () => ({ getWalletRuntime: () => ({ instance: active }) }))

const PAYEE = PrivateKey.fromRandom().toPublicKey().toString()
const txid = (n: number) => n.toString(16).padStart(2, '0').repeat(32)
const notice = (n: number, extra: Record<string, unknown> = {}) => ({
  txid: txid(n),
  vout: 0,
  satoshis: 100 + n,
  payee: PAYEE,
  derivationPrefix: `pre${n}`,
  derivationSuffix: 'suf',
  ...extra,
})

async function device() {
  vi.resetModules()
  store.clear()
  return import('./noticeJournal')
}

describe('notice journal', () => {
  beforeEach(() => {
    Object.assign(host, { body: null, etag: 0, puts: 0 })
  })

  it('lists what is owed until it is done, and keeps only the tombstone', async () => {
    const j = await device()
    expect(j.journalOwedNotice(active, notice(1, { chatRef: true }))).toBe(true)
    expect(j.journalOwedNotice(active, notice(1, { chatRef: true }))).toBe(false)
    j.journalOwedNotice(active, notice(2))
    expect(j.owedJournalNotices(active)).toEqual([
      { txid: txid(1), vout: 0, satoshis: 101, payee: PAYEE, derivationPrefix: 'pre1', derivationSuffix: 'suf', chatRef: true },
      expect.objectContaining({ txid: txid(2), chatRef: false }),
    ])

    j.journalNoticeDone(active, txid(1), 0)
    expect(j.owedJournalNotices(active).map((n) => n.txid)).toEqual([txid(2)])
    expect(j.noticeJournalSettled(active, txid(1), 0)).toBe(true)
    expect(j.noticeJournalSettled(active, txid(2), 0)).toBe(false)
    expect(j.noticeJournalEntries(active)).toEqual([
      expect.objectContaining({ k: 'owed', op: `${txid(2)}.0` }),
      { k: 'done', op: `${txid(1)}.0` },
    ])
  })

  it('a stale replica cannot revive a delivered notice', async () => {
    const j = await device()
    j.journalOwedNotice(active, notice(1))
    const stale = j.noticeJournalEntries(active)
    j.journalNoticeDone(active, txid(1), 0)
    const settledRoot = j.noticeJournalRoot(active)

    expect(j.appendNoticeEntries(active, stale).added).toBe(0)
    expect(j.owedJournalNotices(active)).toEqual([])
    expect(j.noticeJournalRoot(active)).toBe(settledRoot)
  })

  it('keeps a small Atomic BEEF for a recovering device and drops a large one', async () => {
    const j = await device()
    j.journalOwedNotice(active, notice(1, { atomicBeef: [1, 2, 3] }))
    j.journalOwedNotice(active, notice(2, { atomicBeef: Array.from({ length: 60_000 }, () => 7) }))
    expect(j.noticeJournalBeef(active, txid(1))).toEqual([1, 2, 3])
    expect(j.noticeJournalBeef(active, txid(2))).toBeNull()
    expect(j.owedJournalNotices(active)).toHaveLength(2)
  })

  it('refuses entries that could not produce a notice', async () => {
    const j = await device()
    expect(j.cleanNoticeEntry({ k: 'owed', op: `${txid(1)}.0`, sats: 0, payee: PAYEE, prefix: 'a', suffix: 'b' })).toBeNull()
    expect(j.cleanNoticeEntry({ k: 'owed', op: `${txid(1)}.0`, sats: 5, payee: 'nope', prefix: 'a', suffix: 'b' })).toBeNull()
    expect(j.cleanNoticeEntry({ k: 'owed', op: `${txid(1)}.0`, sats: 5, payee: PAYEE, prefix: '', suffix: 'b' })).toBeNull()
    expect(j.cleanNoticeEntry({ k: 'done', op: 'xyz.0' })).toBeNull()
    expect(j.cleanNoticeEntry({ k: 'spent', op: `${txid(1)}.0` })).toBeNull()
    expect(j.journalOwedNotice(active, notice(1, { txid: 'nope' }))).toBe(false)
  })

  it('seals beside the history: a lost device leaves what it owed for the next one', async () => {
    const lost = await device()
    lost.journalOwedNotice(active, notice(1))
    expect(await lost.syncNoticeJournal(active as never, 'grew')).toMatchObject({ kind: 'synced', pushed: true })
    expect(host.body).not.toContain(txid(1))
    expect(host.body).not.toContain(PAYEE)

    const next = await device()
    expect(await next.syncNoticeJournal(active as never, 'recover')).toMatchObject({ kind: 'synced', pulled: 1 })
    expect(next.owedJournalNotices(active).map((n) => n.txid)).toEqual([txid(1)])
  })

  it('a displaced install voids what it never broadcast, and the holder never owes it', async () => {
    const displaced = await device()
    displaced.journalOwedNotice(active, notice(1, { atomicBeef: [1, 2, 3] }))
    displaced.journalOwedNotice(active, notice(1, { vout: 1 }))
    displaced.journalOwedNotice(active, notice(2))
    await displaced.syncNoticeJournal(active as never, 'grew')

    expect(displaced.voidJournalNotices(active, [txid(1)])).toBe(2)
    expect(displaced.voidJournalNotices(active, [txid(1)])).toBe(2)
    expect(displaced.noticeJournalBeef(active, txid(1))).toBeNull()
    const notOpen = { ...active }
    expect(await displaced.syncNoticeJournal(notOpen as never, 'handover')).toMatchObject({ pushed: false })
    const elsewhere = { rootKeyHex: active.rootKeyHex, owner: notOpen }
    expect(await displaced.syncNoticeJournalFor(elsewhere, 'handover')).toMatchObject({ kind: 'synced', pushed: true })

    const holder = await device()
    await holder.syncNoticeJournal(active as never, 'recover')
    expect(holder.owedJournalNotices(active).map((n) => n.txid)).toEqual([txid(2)])
  })

  it('two devices converge: a delivery on one settles the notice on both', async () => {
    const a = await device()
    a.journalOwedNotice(active, notice(1))
    a.journalOwedNotice(active, notice(2))
    await a.syncNoticeJournal(active as never, 'grew')

    const b = await device()
    await b.syncNoticeJournal(active as never, 'recover')
    b.journalNoticeDone(active, txid(1), 0)
    await b.syncNoticeJournal(active as never, 'grew')

    const a2 = await device()
    a2.journalOwedNotice(active, notice(1))
    a2.journalOwedNotice(active, notice(2))
    await a2.syncNoticeJournal(active as never, 'unlock')
    expect(a2.owedJournalNotices(active).map((n) => n.txid)).toEqual([txid(2)])
    expect(a2.noticeJournalRoot(active)).toBe(b.noticeJournalRoot(active))
  })
})
