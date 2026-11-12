/// <reference lib="webworker" />
// Argon2id in a dedicated worker: the 7-pass 128 MiB derivation no longer
// freezes the UI thread. Same parameters and output as the main-thread path.
import { errorText } from './errorText'
import argon2Api from 'hash-wasm/dist/argon2.umd.min.js'

type Req = {
  id: number
  password: Uint8Array
  salt: Uint8Array
  iterations: number
  parallelism: number
  memorySize: number
  hashLength: number
}

const scope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = async (event: MessageEvent<Req | { id: number; ping: true }>) => {
  const msg = event.data
  if ('ping' in msg) {
    scope.postMessage({ id: msg.id, ok: typeof WebAssembly === 'object' })
    return
  }
  try {
    const out = (await argon2Api.argon2id({
      password: msg.password,
      salt: msg.salt,
      iterations: msg.iterations,
      parallelism: msg.parallelism,
      memorySize: msg.memorySize,
      hashLength: msg.hashLength,
      outputType: 'binary',
    })) as Uint8Array
    scope.postMessage({ id: msg.id, ok: true, out }, [out.buffer])
  } catch (error) {
    scope.postMessage({ id: msg.id, ok: false, error: errorText(error) })
  }
}
