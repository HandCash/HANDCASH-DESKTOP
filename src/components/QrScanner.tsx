import { useEffect, useRef, useState } from 'react'

type Props = {
  onScan: (value: string) => void
  onCancel: () => void
  hint?: string
}

type BarcodeDetectorLike = {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>>
}

function getBarcodeDetector(): (new (opts?: { formats: string[] }) => BarcodeDetectorLike) | null {
  const ctor = (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector
  return typeof ctor === 'function'
    ? (ctor as new (opts?: { formats: string[] }) => BarcodeDetectorLike)
    : null
}

async function openCamera(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  })
}

/**
 * Camera QR scanner. Prefers native BarcodeDetector; falls back to @zxing/browser
 * so Android WebView / Capacitor still works for scan-to-link.
 */
export function QrScanner({
  onScan,
  onCancel,
  hint = 'Point your camera at a QR code',
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const onScanRef = useRef(onScan)
  const zxingControlsRef = useRef<{ stop: () => void } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState(false)
  const handled = useRef(false)

  useEffect(() => {
    onScanRef.current = onScan
  }, [onScan])

  useEffect(() => {
    let cancelled = false
    let raf = 0
    let detector: BarcodeDetectorLike | null = null

    const stopTracks = () => {
      cancelAnimationFrame(raf)
      zxingControlsRef.current?.stop()
      zxingControlsRef.current = null
      const stream = streamRef.current
      streamRef.current = null
      stream?.getTracks().forEach((t) => t.stop())
      const video = videoRef.current
      if (video) video.srcObject = null
    }

    const finish = (value: string) => {
      if (handled.current || cancelled) return
      const trimmed = value.trim()
      if (!trimmed) return
      handled.current = true
      stopTracks()
      onScanRef.current(trimmed)
    }

    const tickNative = async () => {
      if (cancelled || handled.current || !detector) return
      const video = videoRef.current
      if (!video || video.readyState < 2) {
        raf = requestAnimationFrame(() => {
          void tickNative()
        })
        return
      }
      try {
        const codes = await detector.detect(video)
        const value = codes[0]?.rawValue?.trim()
        if (value) {
          finish(value)
          return
        }
      } catch {
        // keep scanning
      }
      raf = requestAnimationFrame(() => {
        void tickNative()
      })
    }

    const startWithZxing = async (stream: MediaStream) => {
      const { BrowserMultiFormatReader } = await import('@zxing/browser')
      const reader = new BrowserMultiFormatReader()
      const video = videoRef.current
      if (!video || cancelled) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      video.srcObject = stream
      await video.play()
      if (cancelled) {
        stopTracks()
        return
      }
      setActive(true)
      const controls = await reader.decodeFromStream(stream, video, (result, _err, ctrl) => {
        if (result) {
          ctrl.stop()
          finish(result.getText())
        }
      })
      zxingControlsRef.current = controls
    }

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Camera is not available. Paste the pair code or identity key instead.')
        return
      }

      const Detector = getBarcodeDetector()
      try {
        const stream = await openCamera()
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }

        if (Detector) {
          try {
            detector = new Detector({ formats: ['qr_code'] })
            streamRef.current = stream
            const video = videoRef.current
            if (video) {
              video.srcObject = stream
              await video.play()
            }
            if (cancelled) {
              stopTracks()
              return
            }
            setActive(true)
            raf = requestAnimationFrame(() => {
              void tickNative()
            })
            return
          } catch {
            // Native detector unavailable for this stream — use zxing on the same stream.
            detector = null
          }
        }

        await startWithZxing(stream)
      } catch (err) {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        if (/NotAllowed|Permission|denied/i.test(msg)) {
          setError('Camera access was denied. Paste the code instead.')
        } else if (/NotFound|DevicesNotFound/i.test(msg)) {
          setError('No camera found. Paste the code instead.')
        } else {
          setError(`${msg || 'Camera failed'}. Paste the code instead.`)
        }
      }
    }

    void start()
    return () => {
      cancelled = true
      stopTracks()
    }
  }, [])

  return (
    <div
      className="qr-scanner"
      data-aeon-scope="qr-scanner"
      data-aeon-state={error ? 'error' : active ? 'ready' : 'loading'}
    >
      <div className="qr-scanner-frame">
        <video ref={videoRef} className="qr-scanner-video" muted playsInline />
        <div className="qr-scanner-reticle" aria-hidden />
      </div>
      <p className="qr-scanner-hint">{error ?? hint}</p>
      <div className="actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/** Pull a compressed/uncompressed pubkey out of raw QR text when possible. */
export function identityKeyFromScan(raw: string): string {
  const text = raw.trim()
  const hex = text.match(/(02|03)[0-9a-fA-F]{64}|04[0-9a-fA-F]{128}/)?.[0]
  return hex ?? text
}
