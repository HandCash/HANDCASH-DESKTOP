/**
 * Retire proof requests whose proof is already stored.
 *
 * A `provenTxReq` carries the raw transaction, its input BEEF and the
 * monitor's history notes until a proof arrives. Once the proof row exists the
 * toolbox reads the transaction from `provenTxs` and never consults the request
 * again (`getProvenOrRawTx` checks the proof first). The server toolbox deletes
 * these rows in `purgeData`; the client build ships that task as a no-op, so on
 * a busy wallet they grew to most of the BRC-38 history document (29 MB of a
 * 40 MB backup) and of the phone's IndexedDB.
 *
 * Eligibility mirrors the server purge: `completed`, linked to a proof, and
 * `notified` (the transaction row already carries the proof id). This also
 * requires the linked proof row to exist, so a request is never the last copy
 * of a transaction. See `layers.ts` (localState, historyReplica).
 */
import { appendAppLog } from './appLog'

/** Old enough that the monitor and every Activity projection have settled. */
export const PROOF_REQUEST_RETENTION_MS = 3 * 24 * 60 * 60 * 1000

type IdbCursor = {
  value: Record<string, unknown>
  delete(): Promise<void>
  continue(): Promise<IdbCursor | null>
}

type IdbTrx = {
  objectStore(name: string): {
    get(key: number): Promise<unknown>
    index(name: string): { openCursor(query: string): Promise<IdbCursor | null> }
  }
  done: Promise<void>
}

/** The toolbox `StorageIdb` surface this purge needs. */
export type ProofRequestStore = {
  toDbTrx?: (stores: string[], mode: 'readwrite') => IdbTrx
}

export type ProofRequestPurge = { purged: number; bytes: number }

function byteLength(value: unknown): number {
  if (value == null) return 0
  if (typeof value === 'string') return value.length
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    return (value as ArrayLike<unknown>).length
  }
  return 0
}

function timeOf(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string' || typeof value === 'number') return new Date(value).getTime()
  return Number.NaN
}

export function proofRequestIsRetired(
  req: Record<string, unknown>,
  now: number,
): boolean {
  if (req.status !== 'completed') return false
  if (req.notified !== true && req.notified !== 1) return false
  if (typeof req.provenTxId !== 'number' || req.provenTxId <= 0) return false
  const updated = timeOf(req.updated_at)
  return Number.isFinite(updated) && now - updated >= PROOF_REQUEST_RETENTION_MS
}

export async function purgeRetiredProofRequests(
  storage: ProofRequestStore,
  now = Date.now(),
): Promise<ProofRequestPurge> {
  const out: ProofRequestPurge = { purged: 0, bytes: 0 }
  if (typeof storage.toDbTrx !== 'function') return out

  const started = Date.now()
  const trx = storage.toDbTrx(['proven_tx_reqs', 'proven_txs'], 'readwrite')
  const proofs = trx.objectStore('proven_txs')
  let cursor = await trx.objectStore('proven_tx_reqs').index('status').openCursor('completed')
  while (cursor) {
    const req = cursor.value
    if (proofRequestIsRetired(req, now) && (await proofs.get(req.provenTxId as number)) != null) {
      out.bytes += byteLength(req.rawTx) + byteLength(req.inputBEEF) + byteLength(req.history)
      await cursor.delete()
      out.purged += 1
    }
    cursor = await cursor.continue()
  }
  await trx.done

  if (out.purged > 0) {
    appendAppLog(
      'info',
      `[proof-purge] purge done ${Date.now() - started}ms — ${out.purged} completed proof request(s), ${Math.round(out.bytes / 1024)}KB`,
    )
  }
  return out
}
