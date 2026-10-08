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
const host = { body: null as string | null, etag: 0, puts: 0, gets: 0 }
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
    host.gets += 1
    if (host.body == null) return new Response('{}', { status: 404 })
    // The edge weakens the ETag of a compressed GET.
    return new Response(host.body, { status: 200, headers: { ETag: `W/"${host.etag}"` } })
  },
}))
vi.mock('./historyBackupPrefs', () => ({ resolveHistoryBackupBaseUrl: () => 'https://box.test' }))

const root = PrivateKey.fromRandom()
const identityKey = root.toPublicKey().toString()
const active = { identityKey, accountIndex: 0, chain: 'main' as const, rootKeyHex: root.toHex() }
vi.mock('./walletRuntime', () => ({ getWalletRuntime: () => ({ instance: active }) }))

const txid = (n: number) => n.toString(16).padStart(2, '0').repeat(32)
const out = (n: number) => ({ k: 'out', op: `${txid(n)}.0`, sats: n, r: { p: 'wallet payment', prefix: `p${n}`, suffix: 's' } })

async function device() {
  vi.resetModules()
  store.clear()
  return {
    journal: await import('./custodyJournal'),
    backup: await import('./custodyJournalBackup'),
  }
}

describe('custody journal backup', () => {
  beforeEach(() => {
    Object.assign(host, { body: null, etag: 0, puts: 0, gets: 0 })
  })

  it('seals so only this identity can open it', async () => {
    const { backup } = await device()
    const sealed = await backup.sealCustodyJournal(active.rootKeyHex, identityKey, 'r', [out(1)])
    expect(JSON.stringify(sealed)).not.toContain('p1')
    expect(await backup.openCustodyJournal(active.rootKeyHex, identityKey, sealed)).toEqual([out(1)])
    const other = PrivateKey.fromRandom()
    await expect(
      backup.openCustodyJournal(other.toHex(), identityKey, sealed),
    ).rejects.toThrow()
    await expect(
      backup.openCustodyJournal(active.rootKeyHex, other.toPublicKey().toString(), sealed),
    ).rejects.toThrow(/another identity/)
  })

  it('unions two devices: neither can erase the other', async () => {
    const a = await device()
    a.journal.appendCustody(active, [out(1)])
    expect(await a.backup.syncCustodyJournal(active as never, 'unlock')).toMatchObject({ kind: 'synced', pushed: true })

    const b = await device()
    b.journal.appendCustody(active, [out(2)])
    expect(await b.backup.syncCustodyJournal(active as never, 'unlock')).toMatchObject({ pulled: 1, pushed: true })
    expect(b.journal.custodyEntries(active)).toHaveLength(2)

    const fresh = await device()
    await fresh.backup.syncCustodyJournal(active as never, 'recompose')
    expect(fresh.journal.unspentCustodyOutputs(active).map((o) => o.sats).sort()).toEqual([1, 2])
  })

  it('pushes growth without a read, and rereads only when another device wrote first', async () => {
    const a = await device()
    a.journal.appendCustody(active, [out(1)])
    await a.backup.syncCustodyJournal(active as never, 'unlock')
    const reads = host.gets
    a.journal.appendCustody(active, [out(3)])
    await a.backup.syncCustodyJournal(active as never, 'grew')
    expect(host.gets).toBe(reads)

    // Another device lands a write; our cached etag goes stale.
    const sealed = await a.backup.sealCustodyJournal(active.rootKeyHex, identityKey, 'other', [out(9)])
    host.body = JSON.stringify(sealed)
    host.etag += 1
    a.journal.appendCustody(active, [out(4)])
    expect(await a.backup.syncCustodyJournal(active as never, 'grew')).toMatchObject({ pulled: 1, pushed: true })
    expect(a.journal.custodyRecipeFor(active, `${txid(9)}.0`)).not.toBeNull()
  })

  it('skips the push when both sides already hold the same set', async () => {
    const a = await device()
    a.journal.appendCustody(active, [out(1)])
    await a.backup.syncCustodyJournal(active as never, 'unlock')
    const puts = host.puts
    expect(await a.backup.syncCustodyJournal(active as never, 'recompose')).toMatchObject({ pushed: false })
    expect(host.puts).toBe(puts)
  })

  it('replaces an unreadable remote object instead of stalling', async () => {
    host.body = '{"v":1,"identityKey":"x","iv":"AAAA","ciphertext":"AAAA"}'
    host.etag = 5
    const a = await device()
    a.journal.appendCustody(active, [out(1)])
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await a.backup.syncCustodyJournal(active as never, 'unlock')).toMatchObject({ pushed: true })
  })
})
