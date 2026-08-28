/**
 * Camera stream handoff for the mounted Scan panel.
 *
 * Do not open getUserMedia from hover/focus. The LED loops if a warm stream
 * lives after Scan closes. Only QrScanner (visible Scan) may take a stream.
 */
import { openQrCamera } from './qrCameraConstraints'

let liveStream: MediaStream | null = null
let livePromise: Promise<MediaStream> | null = null

function platform(): string | undefined {
  return typeof window !== 'undefined' ? window.handcash?.platform : undefined
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop())
}

/** @deprecated No-op — camera opens only while Scan is visible. */
export function warmQrCamera(): void {
  // Intentionally empty. Hover-warm left the LED on after leaving Scan.
}

/** Open (or reuse) a stream. Caller must be the visible QrScanner. */
export async function takeQrCameraStream(): Promise<MediaStream> {
  if (liveStream != null) {
    const stream = liveStream
    liveStream = null
    livePromise = null
    return stream
  }
  if (livePromise != null) {
    const pending = livePromise
    livePromise = null
    try {
      const stream = await pending
      liveStream = null
      return stream
    } catch {
      /* fall through */
    }
  }
  const request = openQrCamera(
    (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    platform(),
  )
  livePromise = request
  try {
    const stream = await request
    if (livePromise !== request) {
      // Released while opening — do not hand a live stream back.
      stopStream(stream)
      throw new Error('Camera closed')
    }
    livePromise = null
    return stream
  } catch (err) {
    if (livePromise === request) livePromise = null
    throw err
  }
}

/** Stop every unused / leftover track (Scan unmount, Close, nav leave). */
export function releaseWarmedQrCamera(): void {
  stopStream(liveStream)
  liveStream = null
  if (livePromise != null) {
    const pending = livePromise
    livePromise = null
    void pending.then(stopStream).catch(() => {})
  }
}
