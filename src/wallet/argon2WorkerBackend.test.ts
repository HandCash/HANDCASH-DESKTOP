import { describe, expect, it } from 'vitest'
import { createArgon2WorkerBackend } from './argon2WorkerBackend'

function fakeWorker() {
  const w = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    onerror: null as (() => void) | null,
    postMessage(msg: { id: number; ping?: true }) {
      queueMicrotask(() =>
        w.onmessage?.({
          data: msg.ping ? { id: msg.id, ok: true } : { id: msg.id, ok: true, out: new Uint8Array([1, 2, 3]) },
        } as MessageEvent),
      )
    },
  }
  return w as unknown as Worker
}

describe('argon2 worker backend', () => {
  it('is ready only after preload and derives via the worker', async () => {
    const b = createArgon2WorkerBackend(fakeWorker)
    expect(b.isReady()).toBe(false)
    await b.preload()
    expect(b.isReady()).toBe(true)
    const out = await b.deriveKey({
      password: new Uint8Array([1]),
      salt: new Uint8Array(16),
      iterations: 7,
      parallelism: 1,
      memorySize: 131072,
      hashLength: 32,
    })
    expect([...out]).toEqual([1, 2, 3])
  })
})
