import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { StorageIdb, exportBRC38Json, parseBRC38Json } from '@bsv/wallet-toolbox-client'

const watchdog = vi.hoisted(() => ({ noteBackupOversize: vi.fn(), clearBackupOversize: vi.fn() }))
vi.mock('./backupWatchdog', () => watchdog)

import { exportBrc38JsonStreaming } from './brc38StreamExport'
import { HistoryDocumentTooLargeError } from './historyDocumentBudget'

const bytes = (n: number, seed: number) => Array.from({ length: n }, (_, i) => (i * 7 + seed) % 256)

async function populatedWallet() {
  const identityKey = PrivateKey.fromRandom().toPublicKey().toString()
  const storage = new StorageIdb({
    chain: 'main',
    feeModel: { model: 'sat/kb', value: 1 },
    commissionSatoshis: 0,
  } as ConstructorParameters<typeof StorageIdb>[0])
  await storage.migrate(`brc38-stream-${crypto.randomUUID()}`, PrivateKey.fromRandom().toPublicKey().toString())
  await storage.makeAvailable()
  const { user } = await storage.findOrInsertUser(identityKey)
  const userId = user.userId
  const now = new Date('2026-10-09T12:00:00.000Z')
  const stamp = { created_at: now, updated_at: now }

  const basketId = await storage.insertOutputBasket({
    ...stamp, basketId: 0, userId, name: '1sat', numberOfDesiredUTXOs: 0, minimumDesiredUTXOValue: 0, isDeleted: false,
  })
  const rawTx = bytes(120, 3)
  const txids: string[] = []
  const transactionIds: number[] = []
  for (let n = 0; n < 5; n++) {
    const txid = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')
    txids.push(txid)
    const provenTxId =
      n < 2
        ? await storage.insertProvenTx({
            ...stamp, provenTxId: 0, txid, height: 800_000 + n, index: n, merklePath: bytes(40, n),
            rawTx, blockHash: 'b'.repeat(64), merkleRoot: 'c'.repeat(64),
          })
        : undefined
    transactionIds.push(
      await storage.insertTransaction({
        ...stamp, transactionId: 0, userId, status: 'completed', reference: `ref-${txid.slice(0, 12)}`, isOutgoing: n % 2 === 0,
        satoshis: 100 + n, description: `tx ${n} — ü`, version: 1, lockTime: 0, txid, rawTx,
        inputBEEF: bytes(64 + n, n), provenTxId,
      }),
    )
    await storage.insertProvenTxReq({
      ...stamp, provenTxReqId: 0, status: n < 2 ? 'completed' : 'unmined', attempts: n, notified: false, txid,
      history: JSON.stringify({ notes: [{ what: 'seen', when: now.toISOString(), n }] }),
      notify: JSON.stringify({ transactionIds: [n + 1] }), rawTx, inputBEEF: bytes(30, n), provenTxId,
    })
  }
  const outputIds: number[] = []
  for (let n = 0; n < 4; n++) {
    outputIds.push(
      await storage.insertOutput({
        ...stamp, outputId: 0, userId, transactionId: transactionIds[n]!, basketId, spendable: true, change: false,
        outputDescription: `item ${n}`, vout: n, satoshis: 1, providedBy: 'you', purpose: '', type: 'custom',
        txid: txids[n]!, lockingScript: bytes(25, n), customInstructions: JSON.stringify({ provenance: { n } }),
      }),
    )
  }
  // A large script kept in the raw transaction: `findOutputs` fills it in.
  await storage.insertOutput({
    ...stamp, outputId: 0, userId, transactionId: transactionIds[4]!, basketId, spendable: true, change: false,
    outputDescription: 'kept in rawTx', vout: 0, satoshis: 1, providedBy: 'you', purpose: '', type: 'custom',
    txid: txids[4]!, scriptOffset: 10, scriptLength: 20,
  })
  const outputTagId = await storage.insertOutputTag({ ...stamp, outputTagId: 0, userId, tag: 'brc150', isDeleted: false })
  for (const outputId of outputIds.slice(0, 2)) {
    await storage.insertOutputTagMap({ ...stamp, outputId, outputTagId, isDeleted: false })
  }
  const txLabelId = await storage.insertTxLabel({ ...stamp, txLabelId: 0, userId, label: 'payment', isDeleted: false })
  for (const transactionId of transactionIds.slice(1, 3)) {
    await storage.insertTxLabelMap({ ...stamp, transactionId, txLabelId, isDeleted: false })
  }
  const certificateId = await storage.insertCertificate({
    ...stamp, certificateId: 0, userId, type: 'dHlwZQ==', serialNumber: 'c2VyaWFs', certifier: identityKey,
    subject: identityKey, revocationOutpoint: `${txids[0]}.0`, signature: 'ab', isDeleted: false,
  })
  for (const fieldName of ['name', 'Email', 'avatar']) {
    await storage.insertCertificateField({
      ...stamp, certificateId, userId, fieldName, fieldValue: `v-${fieldName}`, masterKey: 'bWs=',
    })
  }
  return { storage, identityKey, userId }
}

const withoutExportedAt = (json: string) => json.replace(/"exportedAt":"[^"]+"/, '"exportedAt":""')

describe('streaming BRC-38 export', () => {
  it('is byte-identical to the toolbox export and validates', async () => {
    const { storage, identityKey } = await populatedWallet()
    const toolbox = await exportBRC38Json(storage, identityKey)
    const streamed = await exportBrc38JsonStreaming(storage, identityKey)
    expect(withoutExportedAt(streamed)).toBe(withoutExportedAt(toolbox))
    const parsed = parseBRC38Json(streamed)
    expect(parsed.tables.outputs).toHaveLength(5)
    expect(parsed.tables.outputs.find((o) => o.outputDescription === 'kept in rawTx')?.lockingScript).toBeTruthy()
    expect(parsed.tables.certificateFields).toHaveLength(3)
  }, 60_000)

  it('refuses past the budget with the measured size instead of building the document', async () => {
    const { storage, identityKey } = await populatedWallet()
    const full = (await exportBrc38JsonStreaming(storage, identityKey)).length
    const refusal = exportBrc38JsonStreaming(storage, identityKey, 1_000)
    await expect(refusal).rejects.toBeInstanceOf(HistoryDocumentTooLargeError)
    const bytesNoted = watchdog.noteBackupOversize.mock.calls.at(-1)?.[0] as number
    expect(bytesNoted).toBeGreaterThan(1_000)
    expect(bytesNoted).toBeLessThanOrEqual(full)
  }, 60_000)

  it('raises the toolbox null-member error so the history-note repair still runs', async () => {
    const { storage, identityKey, userId } = await populatedWallet()
    const [req] = await storage.getProvenTxReqsForUser({ userId })
    await storage.updateProvenTxReq(req!.provenTxReqId, { history: JSON.stringify({ notes: [{ txid: null }] }) })
    await expect(exportBRC38Json(storage, identityKey)).rejects.toThrow(/^BRC-38 .* must omit null values$/)
    await expect(exportBrc38JsonStreaming(storage, identityKey)).rejects.toThrow(/^BRC-38 .* must omit null values$/)
  }, 60_000)
})
