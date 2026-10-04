import 'fake-indexeddb/auto'
import { PrivateKey } from '@bsv/sdk'
import { SetupClient, type StorageProvider } from '@bsv/wallet-toolbox-client'
import { describe, expect, it } from 'vitest'
import {
  PROOF_REQUEST_RETENTION_MS,
  purgeRetiredProofRequests,
  type ProofRequestStore,
} from './provenTxReqPurge'

const NOW = Date.parse('2026-10-04T12:00:00Z')
const OLD = new Date(NOW - PROOF_REQUEST_RETENTION_MS - 60_000)
const FRESH = new Date(NOW - 60_000)

type Sp = StorageProvider & {
  insertProvenTx: (row: Record<string, unknown>) => Promise<number>
  insertProvenTxReq: (row: Record<string, unknown>) => Promise<number>
  findProvenTxReqs: (args: { partial: Record<string, unknown> }) => Promise<Array<{ txid: string }>>
}

async function withStorage<T>(fn: (sp: Sp) => Promise<T>): Promise<T> {
  const setup = await SetupClient.createWalletIdb({
    chain: 'main',
    rootKeyHex: PrivateKey.fromRandom().toHex(),
    databaseName: `proof-purge-${Math.random().toString(16).slice(2)}`,
  } as Parameters<typeof SetupClient.createWalletIdb>[0])
  return setup.wallet.storage.runAsStorageProvider((sp) => fn(sp as Sp))
}

let seq = 0
function txid(): string {
  seq += 1
  return seq.toString(16).padStart(64, '0')
}

async function proof(sp: Sp, id: string): Promise<number> {
  return sp.insertProvenTx({
    provenTxId: 0,
    created_at: OLD,
    updated_at: OLD,
    txid: id,
    height: 900_000,
    index: 0,
    merklePath: [1, 2, 3],
    rawTx: [4, 5, 6],
    blockHash: 'aa'.repeat(32),
    merkleRoot: 'bb'.repeat(32),
  })
}

async function request(
  sp: Sp,
  id: string,
  row: { status: string; notified: boolean; provenTxId?: number; updated_at: Date },
): Promise<void> {
  await sp.insertProvenTxReq({
    provenTxReqId: 0,
    created_at: row.updated_at,
    attempts: 1,
    txid: id,
    history: '{}',
    notify: '{}',
    rawTx: new Array(400).fill(7),
    inputBEEF: new Array(4000).fill(8),
    ...row,
  })
}

describe('purgeRetiredProofRequests', () => {
  it('deletes only notified, completed requests whose proof row exists', async () => {
    await withStorage(async (sp) => {
      const retired = txid()
      await request(sp, retired, {
        status: 'completed',
        notified: true,
        provenTxId: await proof(sp, retired),
        updated_at: OLD,
      })

      const recent = txid()
      await request(sp, recent, {
        status: 'completed',
        notified: true,
        provenTxId: await proof(sp, recent),
        updated_at: FRESH,
      })

      const unnotified = txid()
      await request(sp, unnotified, {
        status: 'completed',
        notified: false,
        provenTxId: await proof(sp, unnotified),
        updated_at: OLD,
      })

      const missingProof = txid()
      await request(sp, missingProof, {
        status: 'completed',
        notified: true,
        provenTxId: 9_999,
        updated_at: OLD,
      })

      const pending = txid()
      await request(sp, pending, { status: 'unmined', notified: false, updated_at: OLD })

      const result = await purgeRetiredProofRequests(sp as unknown as ProofRequestStore, NOW)
      expect(result.purged).toBe(1)
      expect(result.bytes).toBeGreaterThanOrEqual(4400)

      const left = (await sp.findProvenTxReqs({ partial: {} })).map((r) => r.txid).sort()
      expect(left).toEqual([recent, unnotified, missingProof, pending].sort())

      const raw = await sp.getProvenOrRawTx(retired)
      expect(raw.proven?.rawTx).toEqual([4, 5, 6])
    })
  })

  it('does nothing on a storage without IndexedDB transactions', async () => {
    expect(await purgeRetiredProofRequests({}, NOW)).toEqual({ purged: 0, bytes: 0 })
  })
})
