/**
 * End-to-end encryption of call media, one encoded frame at a time, on top of
 * DTLS-SRTP: AES-GCM under a key only the two identity keys can derive
 * (`mediaKeys.ts`), so a relay, a TURN server or anything that got between the
 * DTLS endpoints sees ciphertext. The first bytes of a frame (the Opus TOC
 * byte, the VP8 payload header) stay in clear for the packetizer and are
 * authenticated as additional data.
 *
 * Sealed frame: clear header | ciphertext and tag | 12-byte IV | header length.
 * Runs on the main thread or in the transform worker; it uses only WebCrypto.
 */

const IV_BYTES = 12
const TAG_BYTES = 16

export type FrameMode = 'seal' | 'open'
export type FrameKind = 'audio' | 'video'

/** Bytes left in clear: Opus TOC, VP8 key frame header (10) or delta header (3). */
export function clearBytes(kind: FrameKind, type?: string): number {
  if (kind === 'audio') return 1
  return type === 'key' ? 10 : 3
}

export async function sealFrame(key: CryptoKey, data: ArrayBuffer, clear: number): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(data)
  const head = bytes.subarray(0, Math.min(clear, bytes.length))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: head }, key, bytes.subarray(head.length)),
  )
  const out = new Uint8Array(head.length + sealed.length + IV_BYTES + 1)
  out.set(head, 0)
  out.set(sealed, head.length)
  out.set(iv, head.length + sealed.length)
  out[out.length - 1] = head.length
  return out.buffer
}

/** The frame as it was sealed, or null when it was not sealed with this key or was altered. */
export async function openFrame(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer | null> {
  const bytes = new Uint8Array(data)
  if (bytes.length < 1 + IV_BYTES + TAG_BYTES) return null
  const clear = bytes[bytes.length - 1]!
  const ivAt = bytes.length - 1 - IV_BYTES
  if (clear > ivAt - TAG_BYTES) return null
  const head = bytes.subarray(0, clear)
  try {
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes.subarray(ivAt, ivAt + IV_BYTES), additionalData: head },
        key,
        bytes.subarray(clear, ivAt),
      ),
    )
    const out = new Uint8Array(clear + plain.length)
    out.set(head, 0)
    out.set(plain, clear)
    return out.buffer
  } catch {
    return null
  }
}

/** Frames that fail to open in a row before the far side is reported as unreadable. */
export const OPEN_FAILURES_REPORTED = 30

type EncodedFrame = { data: ArrayBuffer; type?: string }

/**
 * Seals or opens every frame passing through. A frame that does not open is
 * dropped, never played; `onUnreadable` fires once after a run of them.
 */
export function frameTransform(
  key: CryptoKey,
  mode: FrameMode,
  kind: FrameKind,
  onUnreadable?: () => void,
): TransformStream<EncodedFrame, EncodedFrame> {
  let failures = 0
  let reported = false
  return new TransformStream({
    async transform(frame, controller) {
      if (mode === 'seal') {
        frame.data = await sealFrame(key, frame.data, clearBytes(kind, frame.type))
        controller.enqueue(frame)
        return
      }
      const opened = await openFrame(key, frame.data)
      if (!opened) {
        failures += 1
        if (failures >= OPEN_FAILURES_REPORTED && !reported) {
          reported = true
          onUnreadable?.()
        }
        return
      }
      failures = 0
      frame.data = opened
      controller.enqueue(frame)
    },
  })
}
