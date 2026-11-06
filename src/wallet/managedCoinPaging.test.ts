import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { StorageIdb } from '@handcash/wallet-engine'

describe('managed coin IDB paging', () => {
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
