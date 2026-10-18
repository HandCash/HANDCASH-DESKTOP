import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { StorageIdb, importBRC38, parseBRC38Json, type StorageProvider } from '@handcash/wallet-engine'

vi.mock('./appLog', () => ({ appendAppLog: vi.fn() }))

import { exportBrc38DeltaJson, exportBrc38JsonStreaming } from './brc38StreamExport'
import {
  listPendingPaymentNotices,
  markPaymentNoticeDelivered,
  parsePaymentOutputInstructions,
  paymentOutputInstructions,
  paymentNoticeStatus,
  type NoticeWallet,
  type PaymentOutputInstructions,
} from './paymentNotice'

const SENDER = PrivateKey.fromRandom().toPublicKey().toString()
const PAYEE = PrivateKey.fromRandom().toPublicKey().toString()
const HOUR = 60 * 60_000

const randomTxid = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')

async function openStorage(): Promise<StorageIdb> {
  const storage = new StorageIdb({
    chain: 'main',
    feeModel: { model: 'sat/kb', value: 1 },
    commissionSatoshis: 0,
  } as ConstructorParameters<typeof StorageIdb>[0])
  storage.dbName = `notice-${crypto.randomUUID()}`
  await storage.migrate(storage.dbName, PrivateKey.fromRandom().toPublicKey().toString())
  await storage.makeAvailable()
  return storage
}

function walletOver(storage: StorageProvider): NoticeWallet {
  return {
    identityKey: SENDER,
    wallet: { storage: { runAsStorageProvider: (fn) => fn(storage) } },
  }
}

type Stamp = { created_at: Date; updated_at: Date }
const at = (ms: number): Stamp => ({ created_at: new Date(ms), updated_at: new Date(ms) })

async function senderWallet() {
  const storage = await openStorage()
  const { user } = await storage.findOrInsertUser(SENDER)
  const userId = user.userId
  const pay = async (
    instructions: PaymentOutputInstructions | null,
    opts: { status?: 'completed' | 'unproven' | 'failed' | 'nosend'; stamp?: Stamp } = {},
  ) => {
    const stamp = opts.stamp ?? at(Date.now() - HOUR)
    const txid = randomTxid()
    const transactionId = await storage.insertTransaction({
      ...stamp, transactionId: 0, userId, status: opts.status ?? 'unproven', reference: `ref-${txid.slice(0, 8)}`,
      isOutgoing: true, satoshis: -500, description: 'HandCash BRC-29 send', version: 1, lockTime: 0, txid,
      rawTx: Array.from({ length: 90 }, (_, i) => i),
    })
    await storage.insertOutput({
      ...stamp, outputId: 0, userId, transactionId, spendable: false, change: false,
      outputDescription: 'BRC-29 payment', vout: 0, satoshis: 500, providedBy: 'you', purpose: '',
      type: 'custom', txid, lockingScript: Array.from({ length: 25 }, (_, i) => i),
      customInstructions: instructions ? paymentOutputInstructions(instructions) : undefined,
    })
    return txid
  }
  return { storage, active: walletOver(storage), pay }
}

const owed = (extra: Partial<PaymentOutputInstructions> = {}): PaymentOutputInstructions => ({
  derivationPrefix: 'cHJlZml4',
  derivationSuffix: 'c3VmZml4',
  payee: PAYEE,
  notice: 'pending',
  ...extra,
})

describe('payment output instructions', () => {
  it('round-trips the notice and the in-thread flag', () => {
    const raw = paymentOutputInstructions(owed({ chatRef: true }))
    expect(parsePaymentOutputInstructions(raw)).toEqual(owed({ chatRef: true }))
  })

  it('reads an output written before notices existed as owing nothing', () => {
    const legacy = JSON.stringify({ derivationPrefix: 'a', derivationSuffix: 'b', payee: PAYEE })
    expect(parsePaymentOutputInstructions(legacy)?.notice).toBeUndefined()
  })

  it('refuses anything that cannot name a payee and its keys', () => {
    expect(parsePaymentOutputInstructions('{')).toBeNull()
    expect(parsePaymentOutputInstructions(JSON.stringify({ ...owed(), payee: 'nope' }))).toBeNull()
    expect(parsePaymentOutputInstructions(JSON.stringify({ ...owed(), derivationSuffix: '' }))).toBeNull()
    expect(parsePaymentOutputInstructions(JSON.stringify({ ...owed(), notice: 'lost' }))).toBeNull()
  })

  it('never reads an asset row as a payment, so its remittance is never rewritten', () => {
    for (const extra of [{ asset: 'ab'.repeat(20) }, { kind: 'token' }, { form: 'held' }]) {
      expect(parsePaymentOutputInstructions(JSON.stringify({ ...owed(), ...extra }))).toBeNull()
    }
  })
})

describe('the notice ledger', () => {
  it('lists exactly the notices owed for payments the network has, oldest first', async () => {
    const w = await senderWallet()
    const later = await w.pay(owed(), { stamp: at(Date.now() - HOUR) })
    const earlier = await w.pay(owed({ chatRef: true }), { status: 'completed', stamp: at(Date.now() - 2 * HOUR) })
    await w.pay(owed({ notice: 'delivered' }))
    await w.pay(owed({ notice: undefined }))
    await w.pay(owed(), { status: 'failed' })
    await w.pay(owed(), { status: 'nosend' })
    await w.pay(owed({ payee: SENDER }))
    await w.pay(null)

    const list = await listPendingPaymentNotices(w.active)
    expect(list.map((n) => n.txid)).toEqual([earlier, later])
    expect(list[0]).toMatchObject({ vout: 0, satoshis: 500, payee: PAYEE.toLowerCase(), chatRef: true })
    expect(list[1]?.chatRef).toBe(false)
  }, 60_000)

  it('marks a notice delivered once, and only a pending one', async () => {
    const w = await senderWallet()
    const txid = await w.pay(owed())
    const legacy = await w.pay(owed({ notice: undefined }))

    expect(await paymentNoticeStatus(w.active, txid, 0)).toBe('pending')
    expect(await markPaymentNoticeDelivered(w.active, txid, 0)).toBe(true)
    expect(await markPaymentNoticeDelivered(w.active, txid, 0)).toBe(false)
    expect(await paymentNoticeStatus(w.active, txid, 0)).toBe('delivered')
    expect(await listPendingPaymentNotices(w.active)).toEqual([])

    expect(await markPaymentNoticeDelivered(w.active, legacy, 0)).toBe(false)
    expect(await paymentNoticeStatus(w.active, legacy, 0)).toBe('untracked')
    expect(await paymentNoticeStatus(w.active, randomTxid(), 0)).toBe('untracked')
    expect(await markPaymentNoticeDelivered(w.active, randomTxid(), 0)).toBe(false)
  }, 60_000)

  it('owes nothing for a payment that failed', async () => {
    const w = await senderWallet()
    const failed = await w.pay(owed(), { status: 'failed' })
    expect(await paymentNoticeStatus(w.active, failed, 0)).toBe('void')
  }, 60_000)

  it('travels in the history backup: a restore owes what the backup owed', async () => {
    const w = await senderWallet()
    const delivered = await w.pay(owed())
    const stillOwed = await w.pay(owed())
    await markPaymentNoticeDelivered(w.active, delivered, 0)

    const restored = await openStorage()
    await importBRC38(restored, parseBRC38Json(await exportBrc38JsonStreaming(w.storage, SENDER)), { mode: 'merge' })
    const list = await listPendingPaymentNotices(walletOver(restored))
    expect(list.map((n) => n.txid)).toEqual([stillOwed])
  }, 60_000)

  it('rides a handover: a delivery after the last upload reaches the new holder', async () => {
    const w = await senderWallet()
    const txid = await w.pay(owed(), { stamp: at(Date.now() - 2 * HOUR) })
    const holder = await openStorage()
    await importBRC38(holder, parseBRC38Json(await exportBrc38JsonStreaming(w.storage, SENDER)), { mode: 'merge' })
    const uploadedAt = Date.now() - HOUR

    await markPaymentNoticeDelivered(w.active, txid, 0)
    const delta = await exportBrc38DeltaJson(w.storage, SENDER, { since: uploadedAt, until: Date.now() + 1 })
    expect(delta).not.toBeNull()
    await importBRC38(holder, parseBRC38Json(delta!.json), { mode: 'merge' })

    expect(await paymentNoticeStatus(walletOver(holder), txid, 0)).toBe('delivered')
    expect(await listPendingPaymentNotices(walletOver(holder))).toEqual([])
  }, 60_000)
})
