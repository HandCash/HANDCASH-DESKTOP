/**
 * Optional Argon2id backend that runs hash-wasm in a Web Worker so unlocking
 * with a password does not block the UI thread. Parameters are untouched:
 * output is byte-identical to the portable path.
 */
type Pending = { resolve: (v: Uint8Array) => void; reject: (e: Error) => void }

interface Backend {
  preload: () => Promise<void>
  isReady: () => boolean
  deriveKey: (o: {
    password: Uint8Array
    salt: Uint8Array
    iterations: number
    parallelism: number
    memorySize: number
    hashLength: number
  }) => Promise<Uint8Array>
}

export function createArgon2WorkerBackend(spawn?: () => Worker): Backend {
  let worker: Worker | null = null
  let ready = false
  let seq = 0
  const pending = new Map<number, Pending>()

  const failAll = (message: string) => {
    for (const p of pending.values()) p.reject(new Error(message))
    pending.clear()
  }

  const ensure = (): Worker => {
    if (worker) return worker
    const w = spawn
      ? spawn()
      : new Worker(new URL('./argon2.worker.ts', import.meta.url), { type: 'module', name: 'argon2id' })
    w.onmessage = (e: MessageEvent) => {
      const m = e.data as { id: number; ok: boolean; out?: Uint8Array; error?: string }
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      if (m.ok && m.out) p.resolve(m.out)
      else if (m.ok) p.resolve(new Uint8Array())
      else p.reject(new Error(m.error ?? 'Argon2id worker failed'))
    }
    w.onerror = () => {
      ready = false
      worker = null
      failAll('Argon2id worker crashed')
    }
    worker = w
    return w
  }

  return {
    async preload() {
      const w = ensure()
      const id = ++seq
      await new Promise<void>((resolve, reject) => {
        pending.set(id, { resolve: () => resolve(), reject })
        w.postMessage({ id, ping: true })
      })
      ready = true
    },
    isReady: () => ready,
    deriveKey(o) {
      const w = ensure()
      const id = ++seq
      return new Promise<Uint8Array>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        w.postMessage({ id, ...o })
      })
    },
  }
}

/** Installs the worker backend globally (same registry as `registerArgon2idBackend`). */
export function installArgon2WorkerBackend(): void {
  if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') return
  const g = globalThis as { __bsvWalletToolboxArgon2idBackendV1?: Backend }
  if (g.__bsvWalletToolboxArgon2idBackendV1) return
  const backend = createArgon2WorkerBackend()
  g.__bsvWalletToolboxArgon2idBackendV1 = backend
  // Warm up now so the first password unlock already uses the worker.
  void backend.preload().catch(() => {
    delete g.__bsvWalletToolboxArgon2idBackendV1
  })
}
