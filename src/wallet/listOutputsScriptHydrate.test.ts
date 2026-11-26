import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { StorageIdb } from '@handcash/wallet-engine'

const RAW_TX_BYTES = 1_000_000
const TXS = 2
const OUTPUTS_PER_TX = 5

/** A 1sat page: ten items minted in two inscription batches, scripts stripped as stored. */
async function inscribedBasket() {
  const storage = new StorageIdb({
    chain: 'main', feeModel: { model: 'sat/kb', value: 1 }, commissionSatoshis: 0,
  } as ConstructorParameters<typeof StorageIdb>[0])
  storage.dbName = `script-hydrate-${crypto.randomUUID()}`
  const identity = PrivateKey.fromRandom().toPublicKey().toString()
  await storage.migrate(storage.dbName, identity)
  await storage.makeAvailable()
  const { user } = await storage.findOrInsertUser(identity)
  const basket = await storage.findOrInsertOutputBasket(user.userId, '1sat')
  const stamp = { created_at: new Date(), updated_at: new Date() }
  const scripts = new Map<string, number[]>()
  for (let t = 0; t < TXS; t++) {
    const txid = (t + 1).toString(16).padStart(64, '0')
    const rawTx = Array.from({ length: RAW_TX_BYTES }, (_, i) => (i * 7 + t) & 0xff)
    await storage.insertProvenTxReq({
      ...stamp, provenTxReqId: 0, status: 'completed', attempts: 0, notified: false,
      txid, history: '{}', notify: '{}', rawTx,
    } as unknown as Parameters<StorageIdb['insertProvenTxReq']>[0])
    const transactionId = await storage.insertTransaction({
      ...stamp, transactionId: 0, userId: user.userId, status: 'completed',
      reference: `mint-${t}`, isOutgoing: false, satoshis: OUTPUTS_PER_TX,
      description: 'mint', version: 1, lockTime: 0, txid,
    })
    for (let vout = 0; vout < OUTPUTS_PER_TX; vout++) {
      const scriptOffset = 100 + vout * 1000
      const scriptLength = 25 + vout
      scripts.set(`${txid}.${vout}`, rawTx.slice(scriptOffset, scriptOffset + scriptLength))
      await storage.insertOutput({
        ...stamp, outputId: 0, userId: user.userId, transactionId,
        basketId: basket.basketId, vout, txid, satoshis: 1, spendable: true, change: false,
        type: 'custom', providedBy: 'you', purpose: '', scriptOffset, scriptLength,
      })
    }
  }
  const auth = { userId: user.userId, identityKey: identity }
  return { storage, auth, scripts }
}

const pageArgs = {
  basket: '1sat', tags: [], tagQueryMode: 'any', includeLockingScripts: true,
  includeTransactions: false, includeCustomInstructions: false, includeTags: true,
  includeLabels: false, limit: 10, offset: 0, seekPermission: false, knownTxids: [],
} as unknown as Parameters<StorageIdb['listOutputs']>[1]

describe('1sat listOutputs script hydrate', () => {
  it('reads each raw transaction once per page and returns the same scripts', async () => {
    const { storage, auth, scripts } = await inscribedBasket()
    try {
      // Before: one validateOutputScript per row, as the hydrate did.
      const rows = await storage.findOutputs({ partial: { userId: auth.userId }, noScript: true })
      expect(rows).toHaveLength(TXS * OUTPUTS_PER_TX)
      const reqReads = vi.spyOn(storage, 'findProvenTxReqs')
      const legacyStarted = performance.now()
      for (const row of rows) await storage.validateOutputScript({ ...row, lockingScript: undefined })
      const legacyMs = performance.now() - legacyStarted
      const legacyReads = reqReads.mock.calls.length
      expect(legacyReads).toBe(TXS * OUTPUTS_PER_TX)

      reqReads.mockClear()
      const reads = vi.spyOn(IDBIndex.prototype, 'get')
      const started = performance.now()
      const page = await storage.listOutputs(auth, pageArgs)
      const ms = performance.now() - started
      const rawReads = reads.mock.calls.filter((c) => typeof c[0] === 'string' && /^[0-9a-f]{64}$/.test(c[0])).length
      reads.mockRestore()
      // The page never falls back to a per-row raw transaction read.
      expect(reqReads).not.toHaveBeenCalled()
      reqReads.mockRestore()

      console.info(
        `[list-outputs perf] ${TXS * OUTPUTS_PER_TX} rows from ${TXS} txs of ${RAW_TX_BYTES / 1e6} MB: ` +
          `before per-row validateOutputScript ${legacyMs.toFixed(0)}ms (${legacyReads} raw-tx reads); ` +
          `after batched page hydrate ${ms.toFixed(0)}ms (${rawReads} raw-tx index reads)`,
      )
      expect(page.outputs).toHaveLength(TXS * OUTPUTS_PER_TX)
      for (const output of page.outputs) {
        const want = scripts.get(output.outpoint)!
        expect(output.lockingScript).toBe(want.map((b) => b.toString(16).padStart(2, '0')).join(''))
      }
      // At most one proven_txs and one proven_tx_reqs lookup per transaction.
      expect(rawReads).toBeLessThanOrEqual(TXS * 2)
    } finally {
      await storage.destroy()
    }
  }, 60_000)

  it('batches tags and labels in one transaction each, skips per-row fallback on missing rawTx, and uses tag index first', async () => {
    const storage = new StorageIdb({
      chain: 'main', feeModel: { model: 'sat/kb', value: 1 }, commissionSatoshis: 0,
    } as ConstructorParameters<typeof StorageIdb>[0])
    storage.dbName = `script-hydrate-batch-${crypto.randomUUID()}`
    const identity = PrivateKey.fromRandom().toPublicKey().toString()
    await storage.migrate(storage.dbName, identity)
    await storage.makeAvailable()
    try {
      const { user } = await storage.findOrInsertUser(identity)
      const basket = await storage.findOrInsertOutputBasket(user.userId, '1sat')
      const stamp = { created_at: new Date(), updated_at: new Date() }
      const sharedTag = await storage.insertOutputTag({ ...stamp, outputTagId: 0, userId: user.userId, tag: '1sat', isDeleted: false })
      const targetTag = await storage.insertOutputTag({ ...stamp, outputTagId: 0, userId: user.userId, tag: 'origin:target_0', isDeleted: false })
      const deletedTag = await storage.insertOutputTag({ ...stamp, outputTagId: 0, userId: user.userId, tag: 'deleted', isDeleted: true })
      const txLabel = await storage.insertTxLabel({ ...stamp, txLabelId: 0, userId: user.userId, label: 'mint-batch', isDeleted: false })
      const missingTxid = 'ab'.repeat(32)
      const transactionId = await storage.insertTransaction({
        ...stamp, transactionId: 0, userId: user.userId, status: 'completed',
        reference: 'mint-missing-raw', isOutgoing: false, satoshis: 10,
        description: 'mint', version: 1, lockTime: 0, txid: missingTxid,
      })
      await storage.insertTxLabelMap({ ...stamp, transactionId, txLabelId: txLabel, isDeleted: false })
      const outputIds: number[] = []
      for (let vout = 0; vout < 10; vout++) {
        const outputId = await storage.insertOutput({
          ...stamp, outputId: 0, userId: user.userId, transactionId,
          basketId: basket.basketId, vout, txid: missingTxid, satoshis: 1, spendable: true, change: false,
          type: 'custom', providedBy: 'you', purpose: '', scriptOffset: 100, scriptLength: 25,
        })
        outputIds.push(outputId)
        await storage.insertOutputTagMap({ ...stamp, outputId, outputTagId: sharedTag, isDeleted: false })
        await storage.insertOutputTagMap({ ...stamp, outputId, outputTagId: deletedTag, isDeleted: false })
        if (vout === 7) {
          await storage.insertOutputTagMap({ ...stamp, outputId, outputTagId: targetTag, isDeleted: false })
        }
      }
      const auth = { userId: user.userId, identityKey: identity }
      const validateSpy = vi.spyOn(storage, 'validateOutputScript')
      const trxSpy = vi.spyOn(storage, 'toDbTrx')
      const page = await storage.listOutputs(auth, {
        ...pageArgs, includeLabels: true, includeTags: true, includeLockingScripts: true, limit: 10,
      } as Parameters<StorageIdb['listOutputs']>[1])
      expect(page.outputs).toHaveLength(10)
      expect(page.outputs[7].tags).toEqual(['1sat', 'origin:target_0'])
      expect(page.outputs[0].tags).toEqual(['1sat'])
      expect(page.outputs[0].labels).toEqual(['mint-batch'])
      // Missing rawTx never triggers per-row validateOutputScript fallback.
      expect(validateSpy).not.toHaveBeenCalled()
      const tagTrxs = trxSpy.mock.calls.filter(([stores]) => stores.includes('output_tags') && stores.includes('output_tags_map'))
      const labelTrxs = trxSpy.mock.calls.filter(([stores]) => stores.includes('tx_labels') && stores.includes('tx_labels_map'))
      expect(tagTrxs).toHaveLength(1)
      expect(labelTrxs).toHaveLength(1)
      validateSpy.mockRestore()
      trxSpy.mockRestore()

      // Tag-filtered listOutputs resolves matching outputIds via output_tags_map first.
      const openCursorSpy = vi.spyOn(IDBObjectStore.prototype, 'openCursor')
      const filtered = await storage.listOutputs(auth, {
        ...pageArgs, tags: ['origin:target_0'], tagQueryMode: 'all', includeLockingScripts: false,
      } as Parameters<StorageIdb['listOutputs']>[1])
      expect(filtered.outputs.map(o => o.outpoint)).toEqual([`${missingTxid}.7`])
      expect(openCursorSpy.mock.calls.map(([key]) => key)).toEqual([outputIds[7]])
      openCursorSpy.mockRestore()
    } finally {
      await storage.destroy()
    }
  })
})
