import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { StorageIdb } from '@handcash/wallet-engine'

it('selects monitor requests through indexes with stable ordering and paging', async () => {
  const storage = new StorageIdb({ chain: 'main', feeModel: { model: 'sat/kb', value: 1 }, commissionSatoshis: 0 } as ConstructorParameters<typeof StorageIdb>[0])
  storage.dbName = `monitor-scan-${crypto.randomUUID()}`
  await storage.migrate(storage.dbName, PrivateKey.fromRandom().toPublicKey().toString())
  await storage.makeAvailable()
  try {
    const ids: number[] = []
    const txids = Array.from({ length: 6 }, (_, i) => i.toString(16).padStart(64, '0'))
    for (let i = 0; i < txids.length; i++) {
      ids.push(await storage.insertProvenTxReq({
        provenTxReqId: 0, created_at: new Date(), updated_at: new Date(), attempts: 0,
        txid: txids[i], status: i % 2 ? 'unmined' : 'completed', notified: false,
        history: '{}', notify: '{}', rawTx: [1, 2, 3],
      }))
    }
    const cursors = vi.spyOn(IDBObjectStore.prototype, 'openCursor')
    const selected = await storage.findProvenTxReqs({ partial: {}, status: ['unmined', 'unmined'] })
    expect(cursors.mock.calls.map(([key]) => key)).toEqual([ids[1], ids[3], ids[5]])
    cursors.mockRestore()
    expect(selected.map(r => r.provenTxReqId)).toEqual([ids[1], ids[3], ids[5]])
    const descending = await storage.findProvenTxReqs({ partial: {}, status: ['unmined'], orderDescending: true, paged: { offset: 1, limit: 1 } })
    expect(descending.map(r => r.provenTxReqId)).toEqual([ids[3]])
    const intersection = await storage.findProvenTxReqs({ partial: {}, txids: [txids[0], txids[3], txids[3]], status: ['unmined'] })
    expect(intersection.map(r => r.provenTxReqId)).toEqual([ids[3]])
    expect(await storage.findProvenTxReqs({ partial: {}, status: ['sending'] })).toEqual([])

    const { user } = await storage.findOrInsertUser(PrivateKey.fromRandom().toPublicKey().toString())
    const stamp = { created_at: new Date(), updated_at: new Date() }
    const kept = await storage.insertOutputTag({ ...stamp, outputTagId: 0, userId: user.userId, tag: 'kept', isDeleted: false })
    const deleted = await storage.insertOutputTag({ ...stamp, outputTagId: 0, userId: user.userId, tag: 'deleted', isDeleted: true })
    const unmapped = await storage.insertOutputTag({ ...stamp, outputTagId: 0, userId: user.userId, tag: 'unmapped', isDeleted: false })
    for (const [outputTagId, isDeleted] of [[kept, false], [deleted, false], [unmapped, true]] as const) {
      await storage.insertOutputTagMap({ ...stamp, outputId: 42, outputTagId, isDeleted })
    }
    const transactions = vi.spyOn(storage, 'toDbTrx')
    expect((await storage.getTagsForOutputId(42)).map(t => t.tag)).toEqual(['kept'])
    expect(transactions).toHaveBeenCalledTimes(1)
    transactions.mockRestore()
  } finally {
    await storage.destroy()
  }
})
