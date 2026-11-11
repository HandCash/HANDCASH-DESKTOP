import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { StorageIdb } from '@handcash/wallet-engine'

async function itemBasket(rows: number) {
  const storage = new StorageIdb({
    chain: 'main', feeModel: { model: 'sat/kb', value: 1 }, commissionSatoshis: 0,
  } as ConstructorParameters<typeof StorageIdb>[0])
  storage.dbName = `resume-page-${crypto.randomUUID()}`
  const identity = PrivateKey.fromRandom().toPublicKey().toString()
  await storage.migrate(storage.dbName, identity)
  await storage.makeAvailable()
  const { user } = await storage.findOrInsertUser(identity)
  const basket = await storage.findOrInsertOutputBasket(user.userId, '1sat')
  const stamp = { created_at: new Date(), updated_at: new Date() }
  for (let i = 0; i < rows; i++) {
    const txid = i.toString(16).padStart(64, '0')
    const transactionId = await storage.insertTransaction({
      ...stamp, transactionId: 0, userId: user.userId, status: 'completed',
      reference: `item-${i}`, isOutgoing: false, satoshis: 1,
      description: 'item', version: 1, lockTime: 0, txid,
    })
    await storage.insertOutput({
      ...stamp, outputId: 0, userId: user.userId, transactionId,
      basketId: basket.basketId, vout: 0, txid, satoshis: 1,
      // Every fourth item was sent on: still in the basket, not spendable.
      spendable: i % 4 !== 3, change: false, type: 'custom', providedBy: 'you',
      purpose: '', lockingScript: [0x51],
    })
  }
  return { storage, identity, userId: user.userId, basketId: basket.basketId }
}

describe('output paging resumes after the last row', () => {
  it('reads the same pages as offset paging without re-reading earlier rows', async () => {
    const { storage, userId, basketId } = await itemBasket(60)
    try {
      const base = {
        partial: { userId, basketId, spendable: true }, noScript: true,
        txStatus: ['completed' as const], orderDescending: true,
      }
      const byOffset: number[][] = []
      for (let offset = 0; ; offset += 10) {
        const page = await storage.findOutputs({ ...base, paged: { limit: 10, offset } })
        byOffset.push(page.map((o) => o.outputId))
        if (page.length < 10) break
      }

      const statusLookups = vi.spyOn(IDBIndex.prototype, 'openKeyCursor')
      const resumed: number[][] = []
      const lookupsPerPage: number[] = []
      let afterOutputId: number | undefined
      for (let offset = 0; ; offset += 10) {
        statusLookups.mockClear()
        const page = await storage.findOutputs({ ...base, paged: { limit: 10, offset }, afterOutputId })
        lookupsPerPage.push(statusLookups.mock.calls.length)
        resumed.push(page.map((o) => o.outputId))
        if (page.length < 10) break
        afterOutputId = page[page.length - 1].outputId
      }
      statusLookups.mockRestore()

      expect(resumed).toEqual(byOffset)
      expect(resumed.flat()).toHaveLength(45)
      // 10 spendable rows sit among at most 14 physical rows; the last page
      // walks only what is left. Offset paging grows with every page.
      expect(Math.max(...lookupsPerPage)).toBeLessThanOrEqual(14)
    } finally {
      await storage.destroy()
    }
  })

  it('resumes ascending scans and the BRC-100 listOutputs read, and reports the last row', async () => {
    const { storage, identity, userId, basketId } = await itemBasket(25)
    try {
      const all = await storage.findOutputs({ partial: { userId, basketId }, noScript: true })
      const page = await storage.findOutputs({
        partial: { userId, basketId }, noScript: true,
        paged: { limit: 5, offset: 5 }, afterOutputId: all[4].outputId,
      })
      expect(page.map((o) => o.outputId)).toEqual(all.slice(5, 10).map((o) => o.outputId))

      const auth = { userId, identityKey: identity }
      const vargs = (offset: number, resumeAfterOutputId?: number) => ({
        basket: '1sat', tags: [], tagQueryMode: 'any', includeLockingScripts: false,
        includeTransactions: false, includeCustomInstructions: false, includeTags: false,
        includeLabels: false, limit: 5, offset, seekPermission: false, knownTxids: [],
        skipTotal: true, ...(resumeAfterOutputId != null ? { resumeAfterOutputId } : {}),
      }) as unknown as Parameters<StorageIdb['listOutputs']>[1]
      const first = await storage.listOutputs(auth, vargs(-1)) as { outputs: { outpoint: string }[]; lastOutputId?: number }
      expect(first.lastOutputId).toBeGreaterThan(0)
      const second = await storage.listOutputs(auth, vargs(-6, first.lastOutputId)) as { outputs: { outpoint: string }[] }
      const byOffset = await storage.listOutputs(auth, vargs(-6)) as { outputs: { outpoint: string }[] }
      expect(second.outputs.map((o) => o.outpoint)).toEqual(byOffset.outputs.map((o) => o.outpoint))
      expect(second.outputs).toHaveLength(5)
    } finally {
      await storage.destroy()
    }
  })

  it('logs a read that re-reads rows to honour an offset, and stays quiet when it resumes', async () => {
    const { storage, identity, userId, basketId } = await itemBasket(160)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const auth = { userId, identityKey: identity }
      const vargs = (resumeAfterOutputId?: number) => ({
        basket: '1sat', tags: [], tagQueryMode: 'any', includeLockingScripts: false,
        includeTransactions: false, includeCustomInstructions: false, includeTags: false,
        includeLabels: false, limit: 5, offset: 110, seekPermission: false, knownTxids: [],
        skipTotal: true, ...(resumeAfterOutputId != null ? { resumeAfterOutputId } : {}),
      }) as unknown as Parameters<StorageIdb['listOutputs']>[1]
      await storage.listOutputs(auth, vargs())
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[list-outputs]'))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(/^\[list-outputs\] basket=1sat limit=5 offset=110 via=offset visited=\d+ skipped=110 returned=5 count=none load=\d+ms hydrate=\d+ms done \d+ms$/)

      warn.mockClear()
      const all = await storage.findOutputs({ partial: { userId, basketId, spendable: true }, noScript: true })
      await storage.listOutputs(auth, vargs(all[109].outputId))
      expect(warn.mock.calls.filter((c) => String(c[0]).startsWith('[list-outputs]'))).toHaveLength(0)
    } finally {
      warn.mockRestore()
      await storage.destroy()
    }
  })
})
