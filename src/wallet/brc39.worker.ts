/// <reference lib="webworker" />
/**
 * BRC-39 encryption and snapshot reads off the UI thread.
 *
 * The canonical KDF is Argon2id with 7 passes over 128 MiB, which is several
 * seconds of solid CPU and a 128 MiB WASM heap. On an Android WebView that is
 * long enough for the system to treat the renderer as hung and kill it, so the
 * work is never allowed to run where the UI lives.
 *
 * Imported from the package root even though only the portable module is used:
 * Desktop and Mobile pin different toolbox versions with different internal
 * layouts, and the Mobile build ships an exports map that seals deep paths off.
 * The root entry is the only specifier that resolves in both.
 */
import { encryptBRC39, type BRC38WalletData } from '@bsv/wallet-toolbox-client'
import { Brc39LeanUnsupportedError, decryptBrc39Lean, encryptBrc39Lean } from './brc39Lean'
import { peerSnapshotFromBrc38, type PeerSnapshot } from './peerSnapshot'

export type Brc39EncryptRequest = {
  id: number
  kind?: 'encrypt'
  json: string
  password: string
}

export type Brc39SnapshotRequest = {
  id: number
  kind: 'snapshot'
  bytes: Uint8Array
  password: string
}

export type Brc39DocumentRequest = Omit<Brc39SnapshotRequest, 'kind'> & { kind: 'document' }
export type Brc39DocumentResponse =
  | { id: number; ok: true; document: BRC38WalletData }
  | { id: number; ok: false; error: string }
export type Brc39WorkerRequest = Brc39EncryptRequest | Brc39SnapshotRequest | Brc39DocumentRequest

export type Brc39EncryptResponse =
  | { id: number; ok: true; bytes: Uint8Array }
  | { id: number; ok: false; error: string }

export type Brc39SnapshotResponse =
  | { id: number; ok: true; snapshot: PeerSnapshot }
  | { id: number; ok: false; error: string }

const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = (event: MessageEvent<Brc39WorkerRequest>) => {
  const request = event.data
  const { id } = request
  void (async () => {
    try {
      if (request.kind === 'document') {
        const document = await decryptBrc39Lean(request.bytes, request.password)
        ctx.postMessage({ id, ok: true, document } satisfies Brc39DocumentResponse)
        return
      }
      if (request.kind === 'snapshot') {
        const doc = await decryptBrc39Lean(request.bytes, request.password)
        const reply: Brc39SnapshotResponse = { id, ok: true, snapshot: peerSnapshotFromBrc38(doc) }
        ctx.postMessage(reply)
        return
      }
      let bytes: Uint8Array
      try {
        bytes = await encryptBrc39Lean(request.json, request.password)
      } catch (err) {
        if (!(err instanceof Brc39LeanUnsupportedError)) throw err
        bytes = Uint8Array.from(await encryptBRC39(request.json, request.password))
      }
      const reply: Brc39EncryptResponse = { id, ok: true, bytes }
      ctx.postMessage(reply, [bytes.buffer])
    } catch (err) {
      ctx.postMessage({
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })()
}
