/**
 * Main-thread client for `brc39.worker.ts`.
 *
 * The worker is created per request and terminated as soon as it answers.
 * Argon2id grows the worker's WASM heap to 128 MiB and never gives it back, so
 * keeping the worker warm would hold that much native memory for the life of
 * the app — on a phone that is the difference between a backup and an OOM kill.
 */
import type {
  Brc39EncryptResponse,
  Brc39DocumentResponse,
  Brc39SnapshotResponse,
  Brc39WorkerRequest,
} from './brc39.worker'
import type { PeerSnapshot } from './peerSnapshot'
import { appendAppLog } from './appLog'

/** Argon2id over a large document is slow on low-end phones; be generous. */
const ENCRYPT_TIMEOUT_MS = 120_000

let workersUsable = typeof Worker !== 'undefined'
let nextId = 1
let abortLiveEncrypt: (() => void) | null = null

/** Terminate an in-flight Argon2 worker so a :3321 request can run. */
export function abortBrc39EncryptInFlight(): boolean {
  if (!abortLiveEncrypt) return false
  abortLiveEncrypt()
  return true
}

function spawn(): Worker {
  return new Worker(new URL('./brc39.worker.ts', import.meta.url), {
    type: 'module',
    name: 'brc39-encrypt',
  })
}

type WorkerReply = Brc39EncryptResponse | Brc39SnapshotResponse | Brc39DocumentResponse
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never

function requestWorker<R extends WorkerReply>(
  request: WithoutId<Brc39WorkerRequest>,
  label: string,
  opts: { abortable: boolean; transfer?: Transferable[] },
): Promise<Extract<R, { ok: true }>> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = spawn()
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }

    const id = nextId++
    let settled = false
    let abortThis: (() => void) | null = null

    const timer = setTimeout(
      () => finish(() => reject(new Error(`BRC-39 ${label} timed out`))),
      ENCRYPT_TIMEOUT_MS,
    )

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (abortThis && abortLiveEncrypt === abortThis) abortLiveEncrypt = null
      clearTimeout(timer)
      worker.terminate()
      fn()
    }

    if (opts.abortable) {
      abortThis = (): void => {
        finish(() => reject(new Error(`BRC-39 ${label} aborted`)))
      }
      abortLiveEncrypt = abortThis
    }

    worker.onmessage = (event: MessageEvent<R>) => {
      const msg = event.data
      if (msg.id !== id) return
      if (msg.ok) finish(() => resolve(msg as Extract<R, { ok: true }>))
      else finish(() => reject(new Error(msg.error)))
    }

    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || 'BRC-39 worker failed')))
    }

    worker.postMessage({ ...request, id } as Brc39WorkerRequest, opts.transfer ?? [])
  })
}

/**
 * Encrypt a BRC-38 JSON document into BRC-39 bytes.
 *
 * Falls back to the main thread only when a module worker cannot be created at
 * all. That path still freezes the UI, so it is loud in the log rather than
 * silent — a backup is worth more than a smooth frame, but we want to know.
 */
export async function encryptBrc39Document(
  json: string,
  password: string,
): Promise<Uint8Array> {
  if (workersUsable) {
    try {
      const reply = await requestWorker<Brc39EncryptResponse>(
        { kind: 'encrypt', json, password },
        'encryption',
        { abortable: true },
      )
      return reply.bytes
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/timed out/i.test(msg)) throw err
      workersUsable = false
      appendAppLog('warn', `[cloud-backup] BRC-39 worker unavailable (${msg}) — encrypting inline`)
    }
  }

  const { Brc39LeanUnsupportedError, encryptBrc39Lean } = await import('./brc39Lean')
  try {
    return await encryptBrc39Lean(json, password)
  } catch (err) {
    if (!(err instanceof Brc39LeanUnsupportedError)) throw err
    const { encryptBRC39 } = await import('@bsv/wallet-toolbox-client')
    return Uint8Array.from(await encryptBRC39(json, password))
  }
}

/**
 * Decrypt a BRC-39 blob and summarize its spends without importing anything.
 *
 * Unlike encryption there is no inline fallback: reading another install's
 * snapshot is evidence, never worth freezing the UI thread for.
 */
export async function readBrc39Snapshot(
  bytes: Uint8Array,
  password: string,
): Promise<PeerSnapshot> {
  if (!workersUsable) throw new Error('BRC-39 worker unavailable')
  const reply = await requestWorker<Brc39SnapshotResponse>(
    { kind: 'snapshot', bytes, password },
    'snapshot read',
    { abortable: false, transfer: [bytes.buffer] },
  )
  return reply.snapshot
}

/** Test hook. */
export function resetBrc39WorkerForTests(): void {
  workersUsable = typeof Worker !== 'undefined'
}

/** Validate the entire authenticated document off the UI thread before recovery. */
export async function decryptBrc39Document(bytes: Uint8Array, password: string) {
  const reply = await requestWorker<Brc39DocumentResponse>(
    { kind: 'document', bytes, password }, 'document validation', { abortable: false },
  )
  return reply.document
}
