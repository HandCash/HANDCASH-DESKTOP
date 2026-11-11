import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { StorageIdb } from '@handcash/wallet-engine'

async function itemBasket(rows: number) {
  const storage = new StorageIdb({
    chain: 'main', feeModel: { model: 'sat/kb', value: 1 }, commissionSatoshis: 0,
  } as ConstructorParameters<typeof StorageIdb>[0])
  storage.dbName = `count-cache-${crypto.randomUUID()}`
  const identity = PrivateKey.fromRandom().toPublicKey().toString()
  await storage.migrate(storage.dbName, identity)
  await storage.makeAvailable()
  const { user } = await storage.findOrInsertUser(identity)
  const basket = await storage.findOrInsertOutputBasket(user.userId, '1sat')
  const addItem = async (i: number) => {
    const stamp = { created_at: new Date(), updated_at: new Date() }
    const txid = i.toString(16).padStart(64, '0')
    const transactionId = await storage.insertTransaction({
      ...stamp, transactionId: 0, userId: user.userId, status: 'completed',
      reference: `item-${i}`, isOutgoing: false, satoshis: 1,
      description: 'item', version: 1, lockTime: 0, txid,
    })
    return storage.insertOutput({
      ...stamp, outputId: 0, userId: user.userId, transactionId,
      basketId: basket.basketId, vout: 0, txid, satoshis: 1,
      spendable: true, change: false, type: 'custom', providedBy: 'you',
      purpose: '', lockingScript: [0x51],
    })
  }
  for (let i = 0; i < rows; i++) await addItem(i)
  return { storage, identity, userId: user.userId, basketId: basket.basketId, addItem }
}

describe('basket output totals', () => {
  it('walk the basket once per write, and every write yields a fresh total', async () => {
    const { storage, userId, basketId, addItem } = await itemBasket(30)
    const walks = vi.spyOn(IDBIndex.prototype, 'openCursor')
    try {
      const args = {
        partial: { userId, basketId, spendable: true },
        txStatus: ['completed' as const],
      }
      expect(await storage.countOutputs(args)).toBe(30)
      walks.mockClear()
      expect(await storage.countOutputs(args)).toBe(30)
      expect(walks).not.toHaveBeenCalled()
      // Same filter, another query: counted on its own.
      expect(await storage.countOutputs({ ...args, txStatus: ['unproven' as const] })).toBe(0)

      const added = await addItem(30)
      expect(await storage.countOutputs(args)).toBe(31)

      await storage.updateOutput(added, { spendable: false })
      expect(await storage.countOutputs(args)).toBe(30)

      walks.mockClear()
      await storage.transaction(async (trx) => {
        expect(await storage.countOutputs({ ...args, trx })).toBe(30)
      })
      expect(walks).toHaveBeenCalled()
    } finally {
      walks.mockRestore()
      await storage.destroy()
    }
  })

  it('spare a full listOutputs page the whole-basket walk when nothing was written', async () => {
    const { storage, identity, userId } = await itemBasket(20)
    try {
      const auth = { userId, identityKey: identity }
      const vargs = {
        basket: '1sat', tags: [], tagQueryMode: 'any', includeLockingScripts: false,
        includeTransactions: false, includeCustomInstructions: false, includeTags: false,
        includeLabels: false, limit: 10, offset: -1, seekPermission: false, knownTxids: [],
      } as unknown as Parameters<StorageIdb['listOutputs']>[1]
      const first = await storage.listOutputs(auth, vargs)
      expect(first.totalOutputs).toBe(20)
      const scans = vi.spyOn(storage, 'filterOutputs')
      const second = await storage.listOutputs(auth, vargs)
      expect(second.totalOutputs).toBe(20)
      // The page is one scan; the total adds none.
      expect(scans).toHaveBeenCalledTimes(1)
      scans.mockRestore()
    } finally {
      await storage.destroy()
    }
  })
})
