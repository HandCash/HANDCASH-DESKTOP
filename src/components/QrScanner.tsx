import { useEffect, useRef, useState } from 'react'
import { BrowserQRCodeReader } from '@zxing/browser'
import { DecodeHintType } from '@zxing/library'

type Props = {
  onScan: (text: string) => void
  active?: boolean
  /** Ignore identical payloads for this long (ms). Lower for multi-frame QR. */
  dedupeMs?: number
}

function isMobilePlatform(): boolean {
  if (typeof document === 'undefined') return false
  return (
    document.documentElement.classList.contains('platform-mobile') ||
    window.handcash?.platform === 'android' ||
    window.handcash?.platform === 'ios'
  )
}

/**
 * Lightweight continuous QR scanner.
 * ZXing handles dense HandCash link QRs better than BarcodeDetector / html5-qrcode.
 * Keeps the camera up until the parent unmounts or sets active=false.
 */
export function QrScanner({ onScan, active = true, dedupeMs = 2500 }: Props) {
  const [error, setError] = useState<string | null>(null)
  const onScanRef = useRef(onScan)
  onScanRef.current = onScan
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    if (!active) return

    const video = videoRef.current
    if (!video) return

    setError(null)
    let cancelled = false
    let controls: { stop: () => void } | undefined
    const seen = new Map<string, number>()

    const hints = new Map<DecodeHintType, unknown>()
    hints.set(DecodeHintType.TRY_HARDER, true)

    const reader = new BrowserQRCodeReader(hints, {
      delayBetweenScanAttempts: dedupeMs < 800 ? 100 : 220,
      delayBetweenScanSuccess: dedupeMs < 800 ? 80 : 1200,
    })

    void (async () => {
      try {
        const mobile = isMobilePlatform()
        controls = await reader.decodeFromConstraints(
          {
            audio: false,
            video: {
              facingMode: { ideal: mobile ? 'environment' : 'user' },
              width: { ideal: 1280, max: 1280 },
              height: { ideal: 720, max: 720 },
              frameRate: { ideal: 15, max: 20 },
            },
          },
          video,
          (result) => {
            if (cancelled || !result) return
            const text = result.getText()?.trim()
            if (!text) return
            const now = Date.now()
            const prev = seen.get(text)
            if (prev != null && now - prev < dedupeMs) return
            seen.set(text, now)
            // Cap map growth during long multi-frame sessions.
            if (seen.size > 400) {
              for (const [k, t] of seen) {
                if (now - t > dedupeMs * 4) seen.delete(k)
              }
            }
            onScanRef.current(text)
          },
        )

        if (cancelled) {
          controls.stop()
          return
        }

        const stream = video.srcObject
        if (stream instanceof MediaStream) {
          const track = stream.getVideoTracks()[0]
          if (track?.applyConstraints) {
            try {
              await track.applyConstraints({
                advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet],
              })
            } catch {
              // ignore
            }
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Camera unavailable')
        }
      }
    })()

    return () => {
      cancelled = true
      try {
        controls?.stop()
      } catch {
        // ignore
      }
      const stream = video.srcObject
      if (stream instanceof MediaStream) {
        for (const track of stream.getTracks()) track.stop()
      }
      video.srcObject = null
    }
  }, [active, dedupeMs])

  return (
    <div className="qr-scanner">
      <div className="qr-scanner-view">
        <video ref={videoRef} className="qr-scanner-video" muted playsInline />
        <div className="qr-scanner-reticle" aria-hidden />
      </div>
      <p className="qr-scanner-hint">Fill the box with the QR and hold steady</p>
      {error ? <p className="settings-hint">{error}. You can paste a link payload instead.</p> : null}
    </div>
  )
}
