/**
 * Main-thread client for `brc39.worker.ts`.
 *
 * The worker is created per request and terminated as soon as it answers.
 * Argon2id grows the worker's WASM heap to 128 MiB and never gives it back, so
 * keeping the worker warm would hold that much native memory for the life of
 * the app — on a phone that is the difference between a backup and an OOM kill.
 */
import type { Brc39EncryptRequest, Brc39EncryptResponse } from './brc39.worker'
import { appendAppLog } from './appLog'

/** Argon2id over a large document is slow on low-end phones; be generous. */
const ENCRYPT_TIMEOUT_MS = 120_000

let workersUsable = typeof Worker !== 'undefined'
let nextId = 1

function spawn(): Worker {
  return new Worker(new URL('./brc39.worker.ts', import.meta.url), {
    type: 'module',
    name: 'brc39-encrypt',
  })
}

function encryptInWorker(json: string, password: string): Promise<Uint8Array> {
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

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate()
      fn()
    }

    const timer = setTimeout(
      () => finish(() => reject(new Error('BRC-39 encryption timed out'))),
      ENCRYPT_TIMEOUT_MS,
    )

    worker.onmessage = (event: MessageEvent<Brc39EncryptResponse>) => {
      const msg = event.data
      if (msg.id !== id) return
      if (msg.ok) finish(() => resolve(msg.bytes))
      else finish(() => reject(new Error(msg.error)))
    }

    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || 'BRC-39 worker failed')))
    }

    const request: Brc39EncryptRequest = { id, json, password }
    worker.postMessage(request)
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
      return await encryptInWorker(json, password)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/timed out/i.test(msg)) throw err
      workersUsable = false
      appendAppLog('warn', `[cloud-backup] BRC-39 worker unavailable (${msg}) — encrypting inline`)
    }
  }

  const { encryptBRC39 } = await import('@bsv/wallet-toolbox-client')
  return Uint8Array.from(await encryptBRC39(json, password))
}

/** Test hook. */
export function resetBrc39WorkerForTests(): void {
  workersUsable = typeof Worker !== 'undefined'
}
