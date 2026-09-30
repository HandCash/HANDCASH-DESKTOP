import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { StorageIdb, decryptBRC39, encryptBRC39, exportBRC38Json } from '@bsv/wallet-toolbox-client'
import { decryptBrc39Lean, encryptBrc39Lean } from './brc39Lean'

async function brc38Document(): Promise<string> {
  const identityKey = PrivateKey.fromRandom().toPublicKey().toString()
  const storage = new StorageIdb({
    chain: 'main',
    feeModel: { model: 'sat/kb', value: 1 },
    commissionSatoshis: 0,
  } as ConstructorParameters<typeof StorageIdb>[0])
  await storage.migrate(`brc39-lean-${crypto.randomUUID()}`, PrivateKey.fromRandom().toPublicKey().toString())
  await storage.makeAvailable()
  await storage.findOrInsertUser(identityKey)
  return exportBRC38Json(storage, identityKey)
}

describe('toolbox IndexedDB surface the activity ledger relies on', () => {
  it('lists settled transaction ids from status_userId without reading records', async () => {
    const identityKey = PrivateKey.fromRandom().toPublicKey().toString()
    const storage = new StorageIdb({
      chain: 'main', feeModel: { model: 'sat/kb', value: 1 }, commissionSatoshis: 0,
    } as ConstructorParameters<typeof StorageIdb>[0])
    await storage.migrate(`ledger-idb-${crypto.randomUUID()}`, PrivateKey.fromRandom().toPublicKey().toString())
    await storage.makeAvailable()
    const { user } = await storage.findOrInsertUser(identityKey)
    const now = new Date()
    const insert = (status: string, n: number) => storage.insertTransaction({
      created_at: now, updated_at: now, transactionId: 0, userId: user.userId, status: status as never,
      reference: `ref-${n}`, isOutgoing: false, satoshis: n, description: `tx ${n}`, version: 1, lockTime: 0,
      txid: n.toString(16).padStart(64, '0'),
    })
    const completed = await insert('completed', 1)
    const unproven = await insert('unproven', 2)
    await insert('failed', 3)
    const trx = (storage as unknown as { toDbTrx: (s: string[], m: string) => {
      objectStore(n: string): { index(n: string): { getAllKeys(q: unknown): Promise<unknown[]> }; get(k: unknown): Promise<unknown> }
      done: Promise<void>
    } }).toDbTrx(['transactions'], 'readonly')
    const index = trx.objectStore('transactions').index('status_userId')
    expect(await index.getAllKeys(['completed', user.userId])).toEqual([completed])
    expect(await index.getAllKeys(['unproven', user.userId])).toEqual([unproven])
    expect(await trx.objectStore('transactions').get(completed)).toMatchObject({ satoshis: 1, description: 'tx 1' })
    await trx.done
  })
})

describe('lean BRC-39', () => {
  it('is byte-compatible with the toolbox in both directions and keeps failing closed', async () => {
    const json = await brc38Document()
    const password = 'history-secret ü'

    const lean = await encryptBrc39Lean(json, password)
    expect(await decryptBRC39(lean, password)).toEqual(JSON.parse(json))

    const toolbox = Uint8Array.from(await encryptBRC39(json, password))
    expect(await decryptBrc39Lean(toolbox, password)).toEqual(await decryptBRC39(toolbox, password))
    expect(Array.from(lean.subarray(0, 33))).toEqual(Array.from(toolbox.subarray(0, 33)))

    await expect(decryptBrc39Lean(lean, 'wrong')).rejects.toThrow('authentication failed')
    const tampered = lean.slice()
    tampered[tampered.length - 20]! ^= 1
    await expect(decryptBrc39Lean(tampered, password)).rejects.toThrow('authentication failed')
    await expect(encryptBrc39Lean('{"brc":38}', password)).rejects.toThrow()
  }, 60_000)
})
