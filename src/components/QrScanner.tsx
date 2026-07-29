import { useEffect, useRef, useState } from 'react'

type Props = {
  onScan: (value: string) => void
  onCancel: () => void
  hint?: string
}

function supportsBarcodeDetector(): boolean {
  return typeof BarcodeDetector === 'function'
}

export function QrScanner({
  onScan,
  onCancel,
  hint = 'Point your camera at an identity QR',
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const onScanRef = useRef(onScan)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState(false)
  const handled = useRef(false)

  useEffect(() => {
    onScanRef.current = onScan
  }, [onScan])

  useEffect(() => {
    let cancelled = false
    let raf = 0
    let detector: BarcodeDetector | null = null

    const stop = () => {
      cancelAnimationFrame(raf)
      const stream = streamRef.current
      streamRef.current = null
      stream?.getTracks().forEach((t) => t.stop())
      const video = videoRef.current
      if (video) video.srcObject = null
    }

    const tick = async () => {
      if (cancelled || handled.current || !detector) return
      const video = videoRef.current
      if (!video || video.readyState < 2) {
        raf = requestAnimationFrame(() => {
          void tick()
        })
        return
      }
      try {
        const codes = await detector.detect(video)
        const value = codes[0]?.rawValue?.trim()
        if (value) {
          handled.current = true
          stop()
          onScanRef.current(value)
          return
        }
      } catch {
        // keep scanning
      }
      raf = requestAnimationFrame(() => {
        void tick()
      })
    }

    const start = async () => {
      if (!supportsBarcodeDetector()) {
        setError('QR scanning is not supported in this build. Paste the identity key instead.')
        return
      }
      try {
        detector = new BarcodeDetector({ formats: ['qr_code'] })
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        const video = videoRef.current
        if (video) {
          video.srcObject = stream
          await video.play()
        }
        setActive(true)
        raf = requestAnimationFrame(() => {
          void tick()
        })
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'Camera access was denied. Paste the identity key instead.',
        )
      }
    }

    void start()
    return () => {
      cancelled = true
      stop()
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
