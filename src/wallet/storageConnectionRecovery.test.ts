import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { StorageIdb, WalletStorageManager } from '@handcash/wallet-engine'

describe('wallet storage connection recovery', () => {
  it('reopens the same database before reads and writes without replaying callbacks', async () => {
    const storage = new StorageIdb({
      chain: 'main', feeModel: { model: 'sat/kb', value: 1 }, commissionSatoshis: 0,
    } as ConstructorParameters<typeof StorageIdb>[0])
    const identity = PrivateKey.fromRandom().toPublicKey().toString()
    await storage.migrate(`connection-recovery-${crypto.randomUUID()}`, identity)
    await storage.makeAvailable()
    const manager = new WalletStorageManager(identity, storage)
    await manager.makeAvailable()
    try {
      const before = storage.db
      const revision = storage.getCashSummaryRevision()
      before!.close()
      const read = vi.fn(async () => storage.findOrInsertUser(identity))
      const first = await manager.runAsReader(read)
      expect(first.user.identityKey).toBe(identity)
      expect(read).toHaveBeenCalledTimes(1)
      expect(storage.db).not.toBe(before)
      expect(storage.getCashSummaryRevision()).toBeGreaterThan(revision)
      storage.db!.close()
      const reopen = vi.spyOn(storage, 'initDB')
      await Promise.all(Array.from({ length: 20 }, () => storage.ensureConnectionReady()))
      expect(reopen).toHaveBeenCalledTimes(1)
      reopen.mockRestore()
      storage.db!.close()
      const write = vi.fn(async () => {
        await storage.findOrInsertOutputBasket(first.user.userId, '1sat')
        throw new Error('operation failed after write')
      })
      await expect(manager.runAsWriter(write)).rejects.toThrow('operation failed after write')
      expect(write).toHaveBeenCalledTimes(1)
      const baskets = await manager.runAsReader(() => storage.findOutputBaskets({ partial: { userId: first.user.userId, name: '1sat' } }))
      expect(baskets).toHaveLength(1)
      await storage.destroy()
      const afterDestroy = vi.fn(async () => undefined)
      await expect(manager.runAsReader(afterDestroy)).rejects.toThrow('closed')
      expect(afterDestroy).not.toHaveBeenCalled()
    } finally {
      await storage.destroy()
    }
  })
})
