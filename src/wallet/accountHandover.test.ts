import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { StorageIdb, importBRC38, parseBRC38Json, type StorageProvider } from '@handcash/wallet-engine'

vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))

import { storageRegistry } from '../storage/registry'
import { accountLocalKeyFor } from './accountLocalKeys'
import {
  handOverAccounts,
  receiveHandovers,
  type HandoverInbox,
  type HandoverIo,
  type HandoverPart,
} from './accountHandover'
import { exportBrc38DeltaJson, exportBrc38JsonStreaming } from './brc38StreamExport'
import { durableGetItem, durableSetItem } from './durableStorage'
import type { ListedMessage } from './messageTransport'
import { identityKeyForAccount } from './vaultAccounts'
import { brc157VaultMaster } from './vaultMaster'

const MASTER = brc157VaultMaster(Array(32).fill(0x51))
const INDEX = 2
const IDENTITY = identityKeyForAccount(MASTER, INDEX)
const HOUR = 60 * 60_000

const bytes = (n: number, seed: number) => Array.from({ length: n }, (_, i) => (i * 11 + seed) % 256)
const randomTxid = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')

async function openStorage(): Promise<StorageIdb> {
  const storage = new StorageIdb({
    chain: 'main',
    feeModel: { model: 'sat/kb', value: 1 },
    commissionSatoshis: 0,
  } as ConstructorParameters<typeof StorageIdb>[0])
  storage.dbName = `handover-${crypto.randomUUID()}`
  await storage.migrate(storage.dbName, PrivateKey.fromRandom().toPublicKey().toString())
  await storage.makeAvailable()
  return storage
}

/**
 * Before the last upload: tx1 with three spendable outputs. After it: tx2
 * (broadcast) spends o1 and creates o4; tx3 (`nosend`, never broadcast) spends
 * o2 and creates o5.
 */
async function displacedWallet() {
  const storage = await openStorage()
  const { user } = await storage.findOrInsertUser(IDENTITY)
  const userId = user.userId
  const now = Date.now()
  const old = { created_at: new Date(now - 3 * HOUR), updated_at: new Date(now - 3 * HOUR) }
  const [basket] = await storage.findOutputBaskets({ partial: { userId, name: 'default' } })
  const basketId =
    basket?.basketId ??
    (await storage.insertOutputBasket({
      ...old, basketId: 0, userId, name: 'default', numberOfDesiredUTXOs: 6, minimumDesiredUTXOValue: 1000, isDeleted: false,
    }))
  const tx = async (stamp: typeof old, status: 'completed' | 'nosend', label: string) => {
    const txid = randomTxid()
    const transactionId = await storage.insertTransaction({
      ...stamp, transactionId: 0, userId, status, reference: `ref-${label}`, isOutgoing: true, satoshis: 0,
      description: label, version: 1, lockTime: 0, txid, rawTx: bytes(90, label.length),
    })
    await storage.insertProvenTxReq({
      ...stamp, provenTxReqId: 0, status: status === 'nosend' ? 'nosend' : 'unmined', attempts: 0, notified: false, txid,
      history: '{}', notify: JSON.stringify({ transactionIds: [transactionId] }), rawTx: bytes(90, label.length),
    })
    return { txid, transactionId }
  }
  const output = async (stamp: typeof old, parent: { txid: string; transactionId: number }, vout: number) =>
    storage.insertOutput({
      ...stamp, outputId: 0, userId, transactionId: parent.transactionId, basketId, spendable: true, change: true,
      outputDescription: `o${vout}`, vout, satoshis: 1000 + vout, providedBy: 'storage', purpose: 'change',
      type: 'P2PKH', txid: parent.txid, lockingScript: bytes(25, vout),
    })
  const tx1 = await tx(old, 'completed', 'tx1')
  const o1 = await output(old, tx1, 0)
  const o2 = await output(old, tx1, 1)
  await output(old, tx1, 2)
  const full = await exportBrc38JsonStreaming(storage, IDENTITY)

  const recent = { created_at: new Date(now - HOUR), updated_at: new Date(now - HOUR) }
  const tx2 = await tx(recent, 'completed', 'tx2')
  await output(recent, tx2, 0)
  await storage.updateOutput(o1, { spendable: false, spentBy: tx2.transactionId })
  const tx3 = await tx(recent, 'nosend', 'tx3')
  await output(recent, tx3, 0)
  await storage.updateOutput(o2, { spendable: false, spentBy: tx3.transactionId })
  return { storage, full, since: now - 2 * HOUR, tx1, tx2, tx3 }
}

async function outputsByOutpoint(storage: StorageProvider) {
  const user = await storage.findUserByIdentityKey(IDENTITY)
  const rows = await storage.findOutputs({ partial: { userId: user!.userId } })
  const txs = await storage.findTransactions({ partial: { userId: user!.userId }, noRawTx: true })
  const txidOf = new Map(txs.map((t) => [t.transactionId, t.txid]))
  return new Map(
    rows.map((o) => [`${o.txid}.${o.vout}`, { spendable: o.spendable, spentBy: o.spentBy ? txidOf.get(o.spentBy) : undefined }]),
  )
}

async function holderWith(fullJson: string) {
  const holder = await openStorage()
  await importBRC38(holder, parseBRC38Json(fullJson), { mode: 'merge' })
  return holder
}

beforeEach(() => {
  const mem = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  })
})

describe('the handover delta (draft BRC-249)', () => {
  it('carries what changed since the last upload, closed over its references, and nothing never broadcast', async () => {
    const w = await displacedWallet()
    const delta = await exportBrc38DeltaJson(w.storage, IDENTITY, { since: w.since, until: Date.now() + 1 })
    expect(delta).not.toBeNull()
    const doc = parseBRC38Json(delta!.json)
    const txids = doc.tables.transactions.map((t) => t.txid).sort()
    expect(txids).toEqual([w.tx1.txid, w.tx2.txid].sort())
    const outpoints = doc.tables.outputs.map((o) => `${o.txid}.${o.vout}`).sort()
    expect(outpoints).toEqual([`${w.tx1.txid}.0`, `${w.tx2.txid}.0`].sort())
    expect(doc.tables.provenTxReqs.map((r) => r.txid)).not.toContain(w.tx3.txid)
  }, 60_000)

  it('is null when nothing changed in the window', async () => {
    const w = await displacedWallet()
    expect(await exportBrc38DeltaJson(w.storage, IDENTITY, { since: Date.now() + 1, until: Date.now() + 2 })).toBeNull()
  }, 60_000)

  it('merged into the holder, applies the broadcast spend and leaves the unsent one out', async () => {
    const w = await displacedWallet()
    const holder = await holderWith(w.full)
    const delta = await exportBrc38DeltaJson(w.storage, IDENTITY, { since: w.since, until: Date.now() + 1 })
    await importBRC38(holder, parseBRC38Json(delta!.json), { mode: 'merge' })
    const outs = await outputsByOutpoint(holder)
    expect(outs.get(`${w.tx1.txid}.0`)).toEqual({ spendable: false, spentBy: w.tx2.txid })
    expect(outs.get(`${w.tx1.txid}.1`)).toEqual({ spendable: true, spentBy: undefined })
    expect(outs.get(`${w.tx2.txid}.0`)?.spendable).toBe(true)
    expect(outs.has(`${w.tx3.txid}.0`)).toBe(false)
  }, 60_000)
})

describe('handing over and receiving', () => {
  function fakeIo(storage: StorageProvider) {
    const sent: string[] = []
    const dropped: string[] = []
    const stopped: string[] = []
    const settled: string[][] = []
    const io: HandoverIo = {
      deviceId: () => 'device-A',
      account: () => ({ chain: 'main', handle: 'tester' }),
      withStorage: (_args, fn) => fn(storage),
      send: async (_root, body) => void sent.push(body),
      dropMinerRetry: (txid) => void dropped.push(txid),
      stopMonitor: (identityKey) => void stopped.push(identityKey),
      settleVoidedNotices: async ({ txids }) => {
        settled.push(txids)
        return txids.length
      },
    }
    return { io, sent, dropped, stopped, settled }
  }

  const listed = (bodies: string[], createdAt = Date.now()): ListedMessage[] =>
    bodies.map((body, i) => ({ messageId: `h${i}`, body, createdAt }))

  function inbox(holder: StorageProvider, opts: { failMerge?: boolean } = {}) {
    const acked: string[] = []
    const box: HandoverInbox = {
      open: (body) => body,
      merge: async (json) => {
        if (opts.failMerge) throw new Error('storage busy')
        await importBRC38(holder, parseBRC38Json(json), { mode: 'merge' })
      },
      acknowledge: async (ids) => void acked.push(...ids),
    }
    return { box, acked }
  }

  it('stops the monitor, voids unsent transactions, sends the delta, and the holder merges it', async () => {
    const w = await displacedWallet()
    durableSetItem(
      accountLocalKeyFor(storageRegistry.historyBackup.key, { identityKey: IDENTITY, accountIndex: INDEX, chain: 'main' }),
      JSON.stringify({ lastUploadedAt: w.since }),
    )
    const { io, sent, dropped, stopped } = fakeIo(w.storage)
    await handOverAccounts(MASTER, [INDEX], io)

    expect(stopped).toEqual([IDENTITY])
    expect(dropped).toEqual([w.tx3.txid])
    const [tx3] = await w.storage.findTransactions({ partial: { transactionId: w.tx3.transactionId }, noRawTx: true })
    expect(tx3!.status).toBe('failed')
    const [req3] = await w.storage.findProvenTxReqs({ partial: { txid: w.tx3.txid } })
    expect(req3!.status).toBe('invalid')
    expect(JSON.parse(durableGetItem(storageRegistry.accountHandoverPending.key) || '[]')).toEqual([])

    expect(sent).toHaveLength(1)
    const holder = await holderWith(w.full)
    const { box, acked } = inbox(holder)
    const seen = await receiveHandovers({ identityKey: IDENTITY, deviceId: 'device-B', messages: listed(sent), inbox: box })
    expect([...seen]).toEqual(['h0'])
    expect(acked).toEqual(['h0'])
    const outs = await outputsByOutpoint(holder)
    expect(outs.get(`${w.tx1.txid}.0`)).toEqual({ spendable: false, spentBy: w.tx2.txid })
    expect(outs.get(`${w.tx1.txid}.1`)?.spendable).toBe(true)
  }, 60_000)

  it('settles the notices of unsent payments before voiding them, and waits while it cannot', async () => {
    const w = await displacedWallet()
    const { io, sent, settled } = fakeIo(w.storage)
    let journalDown = true
    const flaky: HandoverIo = {
      ...io,
      settleVoidedNotices: async (args) => {
        if (journalDown) throw new Error('notice journal not pushed: pull 503')
        return io.settleVoidedNotices(args)
      },
    }

    await handOverAccounts(MASTER, [INDEX], flaky)
    const [stillSigned] = await w.storage.findTransactions({ partial: { transactionId: w.tx3.transactionId }, noRawTx: true })
    expect(stillSigned!.status).not.toBe('failed')
    expect(sent).toEqual([])
    expect(JSON.parse(durableGetItem(storageRegistry.accountHandoverPending.key) || '[]')).toHaveLength(1)

    journalDown = false
    await handOverAccounts(MASTER, [], flaky)
    expect(settled).toEqual([[w.tx3.txid]])
    const [voided] = await w.storage.findTransactions({ partial: { transactionId: w.tx3.transactionId }, noRawTx: true })
    expect(voided!.status).toBe('failed')
    expect(sent).toHaveLength(1)
  }, 60_000)

  it('stays pending when sending fails, and sends on the next flush', async () => {
    const w = await displacedWallet()
    const { io, sent } = fakeIo(w.storage)
    let fail = true
    const flaky: HandoverIo = {
      ...io,
      send: async (root, body) => {
        if (fail) throw new Error('box down')
        await io.send(root, body)
      },
    }
    await handOverAccounts(MASTER, [INDEX], flaky)
    expect(JSON.parse(durableGetItem(storageRegistry.accountHandoverPending.key) || '[]')).toHaveLength(1)
    fail = false
    await handOverAccounts(MASTER, [], flaky)
    expect(sent).toHaveLength(1)
    expect(JSON.parse(durableGetItem(storageRegistry.accountHandoverPending.key) || '[]')).toEqual([])
  }, 60_000)

  const part = (data: string, n: number, parts: number, over: Partial<HandoverPart> = {}): string =>
    JSON.stringify({ v: 1, type: 'handover', identityKey: IDENTITY, deviceId: 'device-A', handoverId: 'h-1', part: n, parts, data, ...over })

  it('waits for every part, joins them in order, and acknowledges only after the merge', async () => {
    const w = await displacedWallet()
    const delta = await exportBrc38DeltaJson(w.storage, IDENTITY, { since: w.since, until: Date.now() + 1 })
    const json = delta!.json
    const cut = [0, Math.floor(json.length / 3), Math.floor((2 * json.length) / 3), json.length]
    const bodies = [2, 0, 1].map((i) => part(json.slice(cut[i], cut[i + 1]), i, 3))
    const holder = await holderWith(w.full)

    const first = inbox(holder)
    await receiveHandovers({ identityKey: IDENTITY, deviceId: 'device-B', messages: listed(bodies.slice(0, 2)), inbox: first.box })
    expect(first.acked).toEqual([])

    const failing = inbox(holder, { failMerge: true })
    await receiveHandovers({ identityKey: IDENTITY, deviceId: 'device-B', messages: listed(bodies), inbox: failing.box })
    expect(failing.acked).toEqual([])

    const all = inbox(holder)
    await receiveHandovers({ identityKey: IDENTITY, deviceId: 'device-B', messages: listed(bodies), inbox: all.box })
    expect(all.acked.sort()).toEqual(['h0', 'h1', 'h2'])
    expect((await outputsByOutpoint(holder)).get(`${w.tx2.txid}.0`)?.spendable).toBe(true)
  }, 60_000)

  it('leaves a complete handover in the box while the account is not open here', async () => {
    const holder = await openStorage()
    const { box, acked } = inbox(holder)
    const seen = await receiveHandovers({
      identityKey: IDENTITY,
      deviceId: 'device-B',
      messages: listed([part('{}', 0, 1)]),
      inbox: { ...box, merge: null },
    })
    expect([...seen]).toEqual(['h0'])
    expect(acked).toEqual([])
  }, 60_000)

  it('ignores its own parts and other accounts, and drops incomplete parts older than a week', async () => {
    const holder = await openStorage()
    const { box, acked } = inbox(holder)
    const messages: ListedMessage[] = [
      { messageId: 'own', body: part('{}', 0, 1, { deviceId: 'device-B' }), createdAt: Date.now() },
      { messageId: 'foreign', body: part('{}', 0, 1, { identityKey: identityKeyForAccount(MASTER, 9) }), createdAt: Date.now() },
      { messageId: 'stale', body: part('{', 0, 2, { handoverId: 'old' }), createdAt: Date.now() - 8 * 24 * HOUR },
      { messageId: 'release', body: '{"v":1,"type":"release-request"}', createdAt: Date.now() },
    ]
    const seen = await receiveHandovers({ identityKey: IDENTITY, deviceId: 'device-B', messages, inbox: box })
    expect([...seen].sort()).toEqual(['own', 'stale'])
    expect(acked).toEqual(['stale'])
  }, 60_000)
})
