import { describe, expect, it, vi } from 'vitest'
import { OPEN_FAILURES_REPORTED, clearBytes, frameTransform, openFrame, sealFrame } from './frameCrypto'

function aesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

const bytes = (b: ArrayBuffer | null) => (b ? Array.from(new Uint8Array(b)) : null)

async function through(t: TransformStream, frames: { data: ArrayBuffer; type?: string }[]) {
  const out: { data: ArrayBuffer }[] = []
  const writer = t.writable.getWriter()
  const reading = (async () => {
    const reader = t.readable.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      out.push(value)
    }
  })()
  for (const f of frames) await writer.write(f)
  await writer.close()
  await reading
  return out
}

describe('frame encryption', () => {
  it('keeps the codec header readable and the rest sealed', async () => {
    const key = await aesKey()
    const frame = new Uint8Array(Array.from({ length: 40 }, (_, i) => i)).buffer
    const sealed = new Uint8Array(await sealFrame(key, frame, 10))
    expect(Array.from(sealed.subarray(0, 10))).toEqual(Array.from({ length: 10 }, (_, i) => i))
    expect(Array.from(sealed.subarray(10, 40))).not.toEqual(Array.from({ length: 30 }, (_, i) => i + 10))
    expect(bytes(await openFrame(key, sealed.buffer))).toEqual(bytes(frame))
  })

  it('refuses an altered header, an altered body or another key', async () => {
    const key = await aesKey()
    const frame = new Uint8Array(24).fill(7).buffer
    const sealed = new Uint8Array(await sealFrame(key, frame, 3))
    const header = sealed.slice()
    header[0] ^= 1
    const body = sealed.slice()
    body[5] ^= 1
    expect(await openFrame(key, header.buffer)).toBeNull()
    expect(await openFrame(key, body.buffer)).toBeNull()
    expect(await openFrame(await aesKey(), sealed.buffer)).toBeNull()
    expect(await openFrame(key, new Uint8Array(8).buffer)).toBeNull()
  })

  it('leaves one byte of audio and a key or delta video header in clear', () => {
    expect(clearBytes('audio')).toBe(1)
    expect(clearBytes('video', 'key')).toBe(10)
    expect(clearBytes('video', 'delta')).toBe(3)
  })

  it('a stream seals frames through, and the far side opens them back', async () => {
    const key = await aesKey()
    const frames = [1, 2, 3].map((n) => ({ data: new Uint8Array(20).fill(n).buffer, type: 'delta' }))
    const plain = frames.map((f) => bytes(f.data))
    const sealed = await through(frameTransform(key, 'seal', 'video'), frames)
    const opened = await through(frameTransform(key, 'open', 'video'), sealed)
    expect(opened.map((f) => bytes(f.data))).toEqual(plain)
  })

  it('drops frames that do not open and reports once after a run of them', async () => {
    const key = await aesKey()
    const onUnreadable = vi.fn()
    const junk = Array.from({ length: OPEN_FAILURES_REPORTED + 5 }, () => ({ data: new Uint8Array(40).buffer }))
    const out = await through(frameTransform(key, 'open', 'audio', onUnreadable), junk)
    expect(out).toHaveLength(0)
    expect(onUnreadable).toHaveBeenCalledTimes(1)
  })
})
