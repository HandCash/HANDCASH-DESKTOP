import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { StorageIdb } from '@handcash/wallet-engine'

describe('managed coin IDB paging', () => {
  it('projects bounded physical pages and rejects a write between pages', async () => {
    const storage = new StorageIdb({
      chain: 'main', feeModel: { model: 'sat/kb', value: 1 }, commissionSatoshis: 0,
    } as ConstructorParameters<typeof StorageIdb>[0])
    storage.dbName = `summary-page-${crypto.randomUUID()}`
    const identity = PrivateKey.fromRandom().toPublicKey().toString()
    await storage.migrate(storage.dbName, identity)
    await storage.makeAvailable()
    try {
      const { user } = await storage.findOrInsertUser(identity)
      const basket = await storage.findOrInsertOutputBasket(user.userId, 'default')
      const stamp = { created_at: new Date(), updated_at: new Date() }
      const txid = 'cd'.repeat(32)
      const transactionId = await storage.insertTransaction({
        ...stamp, transactionId: 0, userId: user.userId, status: 'completed',
        reference: 'summary', isOutgoing: false, satoshis: 25000,
        description: 'summary', version: 1, lockTime: 0, txid,
      })
      let lastId = 0
      for (let vout = 0; vout < 250; vout++) {
        lastId = await storage.insertOutput({
          ...stamp, outputId: 0, userId: user.userId, transactionId,
          basketId: basket.basketId, vout, txid, satoshis: 100,
          spendable: true, change: true, type: 'P2PKH', providedBy: 'storage',
          purpose: 'change', derivationPrefix: 'prefix',
          derivationSuffix: vout === 0 ? '' : 'suffix',
          ...(vout === 1 ? { spentBy: transactionId } : {}),
          lockingScript: [0x51],
        })
      }
      const allKeys = vi.spyOn(IDBIndex.prototype, 'getAllKeys')
      const first = await storage.readCashSummaryPage(identity)
      expect(first).toMatchObject({ sats: 9800, outputCount: 98, rowCount: 100 })
      expect(first.next).not.toBeNull()
      const second = await storage.readCashSummaryPage(identity, first.next!, first.revision)
      expect(second).toMatchObject({ sats: 10000, outputCount: 100, rowCount: 100 })
      const third = await storage.readCashSummaryPage(identity, second.next!, first.revision)
      expect(third).toMatchObject({ sats: 5000, outputCount: 50, rowCount: 50, next: null })
      storage.validateCashSummaryRevision(first.revision)
      expect(allKeys).not.toHaveBeenCalled()
      allKeys.mockRestore()
      await storage.updateOutput(lastId, { spendable: false })
      await expect(storage.readCashSummaryPage(identity, first.next!, first.revision)).rejects.toThrow('changed')
      const updated = await storage.readCashSummaryPage(identity, second.next!)
      expect(updated.outputCount).toBe(49)
      const pending = await storage.readPendingChangePage(identity, second.next!)
      expect(pending.outputs.map(o => o.outputId)).toEqual([lastId])
      expect(pending.next).toBeNull()
      await storage.updateTransaction(transactionId, { status: 'failed' })
      await expect(storage.readCashSummaryPage(identity, 0, updated.revision)).rejects.toThrow('changed')
      expect((await storage.readCashSummaryPage(identity)).sats).toBe(0)
      await expect(storage.readCashSummaryPage('wrong-owner')).rejects.toThrow('owner')
      const beforeScope = await storage.readCashSummaryPage(identity)
      await storage.transaction(async () => {
        await expect(storage.readCashSummaryPage(identity)).rejects.toThrow('changing')
      })
      await expect(storage.readCashSummaryPage(identity, 0, beforeScope.revision)).rejects.toThrow('changed')
    } finally {
      await storage.destroy()
    }
  })

  it('filters incomplete and spent rows before the page and count', async () => {
    const storage = new StorageIdb({
      chain: 'main', feeModel: { model: 'sat/kb', value: 1 }, commissionSatoshis: 0,
    } as ConstructorParameters<typeof StorageIdb>[0])
    storage.dbName = `managed-page-${crypto.randomUUID()}`
    const identity = PrivateKey.fromRandom().toPublicKey().toString()
    await storage.migrate(storage.dbName, identity)
    await storage.makeAvailable()
    try {
      const { user } = await storage.findOrInsertUser(identity)
      const stamp = { created_at: new Date(), updated_at: new Date() }
      const txid = 'ab'.repeat(32)
      const transactionId = await storage.insertTransaction({
        ...stamp, transactionId: 0, userId: user.userId, status: 'completed',
        reference: 'paging', isOutgoing: false, satoshis: 1000,
        description: 'paging', version: 1, lockTime: 0, txid,
      })
      for (let vout = 0; vout < 7; vout++) {
        await storage.insertOutput({
          ...stamp, outputId: 0, userId: user.userId, transactionId,
          vout, txid, satoshis: 100, spendable: true, change: true,
          type: 'P2PKH', providedBy: 'storage', purpose: 'change',
          derivationPrefix: 'prefix', derivationSuffix: vout === 0 ? '' : 'suffix',
          ...(vout === 1 ? { spentBy: transactionId } : {}),
          lockingScript: [0x51],
        })
      }
      // Five valid rows; offset is applied after rejecting the first two.
      const args = {
        partial: { userId: user.userId }, managedOnly: true, noScript: true,
        txStatus: ['completed' as const],
        paged: { limit: 2, offset: 1 },
      }
      const validate = vi.spyOn(storage, 'validateEntity')
      const page = await storage.findOutputs(args)
      expect(page.map(o => o.vout)).toEqual([3, 4])
      expect(validate).toHaveBeenCalledTimes(2)
      expect(await storage.countOutputs({ ...args, paged: undefined })).toBe(5)
    } finally {
      await storage.destroy()
    }
  })
})
