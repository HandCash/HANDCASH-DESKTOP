/**
 * Warm the QR camera before ScanPanel mounts so getUserMedia is already
 * resolving (or done) when the side panel paints.
 */
import { openQrCamera } from './qrCameraConstraints'

let warmStream: MediaStream | null = null
let warmPromise: Promise<MediaStream> | null = null

function platform(): string | undefined {
  return typeof window !== 'undefined' ? window.handcash?.platform : undefined
}

/** Start (or reuse) a background camera open — safe to call from hover/focus. */
export function warmQrCamera(): void {
  if (warmStream != null || warmPromise != null) return
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return
  }
  warmPromise = openQrCamera(
    (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    platform(),
  )
    .then((stream) => {
      warmStream = stream
      warmPromise = null
      return stream
    })
    .catch((err) => {
      warmPromise = null
      throw err
    })
}

/** Consume a warmed stream, or open a fresh one. */
export async function takeQrCameraStream(): Promise<MediaStream> {
  if (warmStream != null) {
    const stream = warmStream
    warmStream = null
    warmPromise = null
    return stream
  }
  if (warmPromise != null) {
    const pending = warmPromise
    warmPromise = null
    try {
      const stream = await pending
      warmStream = null
      return stream
    } catch {
      // Fall through to a fresh open.
    }
  }
  return openQrCamera(
    (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    platform(),
  )
}

/** Drop an unused warm stream (user left without opening Scan). */
export function releaseWarmedQrCamera(): void {
  if (warmStream != null) {
    warmStream.getTracks().forEach((t) => t.stop())
    warmStream = null
  }
  // Leave warmPromise running; take/release on settle via take paths.
  if (warmPromise != null) {
    const pending = warmPromise
    warmPromise = null
    void pending
      .then((stream) => {
        stream.getTracks().forEach((t) => t.stop())
      })
      .catch(() => {})
  }
}
