/// <reference lib="webworker" />
/**
 * BRC-39 encryption off the UI thread.
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
import { encryptBRC39 } from '@bsv/wallet-toolbox-client'

export type Brc39EncryptRequest = {
  id: number
  json: string
  password: string
}

export type Brc39EncryptResponse =
  | { id: number; ok: true; bytes: Uint8Array }
  | { id: number; ok: false; error: string }

const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = (event: MessageEvent<Brc39EncryptRequest>) => {
  const { id, json, password } = event.data
  void (async () => {
    try {
      const bytes = Uint8Array.from(await encryptBRC39(json, password))
      const reply: Brc39EncryptResponse = { id, ok: true, bytes }
      ctx.postMessage(reply, [bytes.buffer])
    } catch (err) {
      const reply: Brc39EncryptResponse = {
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
      ctx.postMessage(reply)
    }
  })()
}
