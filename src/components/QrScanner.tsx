import { useEffect, useRef } from 'react'
import { useMachine } from '@xstate/react'
import { qrScannerMachine } from '../machines/qrScannerMachine'
import { Skeleton } from './Skeleton'

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
      // 720p plus full-rate software decode overheats Android WebViews. QR
      // modules remain crisp at 960×540 while cutting pixel work nearly in half.
      width: { ideal: 960 },
      height: { ideal: 540 },
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
  const [snapshot, send] = useMachine(qrScannerMachine)
  const handled = useRef(false)
  const ready = snapshot.matches('ready')
  const paused = snapshot.matches('paused')
  const error = snapshot.context.error

  useEffect(() => {
    onScanRef.current = onScan
  }, [onScan])

  useEffect(() => {
    const onVisibility = () => {
      send({ type: document.visibilityState === 'hidden' ? 'PAUSE' : 'RESUME' })
    }
    document.addEventListener('visibilitychange', onVisibility)
    onVisibility()
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [send])

  useEffect(() => {
    if (paused) return
    let cancelled = false
    let raf = 0
    let scanTimer = 0
    let detector: BarcodeDetectorLike | null = null

    const stopTracks = () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(scanTimer)
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
      send({ type: 'SCANNED' })
      stopTracks()
      onScanRef.current(trimmed)
    }

    const scheduleNativeScan = () => {
      if (cancelled || handled.current) return
      // BarcodeDetector can saturate a mobile WebView when called every frame.
      // QR acquisition is just as responsive at ~8 attempts/sec.
      scanTimer = window.setTimeout(() => {
        raf = requestAnimationFrame(() => {
          void tickNative()
        })
      }, 120)
    }

    const tickNative = async () => {
      if (cancelled || handled.current || !detector) return
      const video = videoRef.current
      if (!video || video.readyState < 2) {
        scheduleNativeScan()
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
      scheduleNativeScan()
    }

    const startWithZxing = async (stream: MediaStream) => {
      const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] =
        await Promise.all([import('@zxing/browser'), import('@zxing/library')])
      const hints = new Map()
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE])
      const reader = new BrowserMultiFormatReader(hints, {
        delayBetweenScanAttempts: 120,
        delayBetweenScanSuccess: 500,
      })
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
      send({ type: 'CAMERA_READY' })
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
        send({
          type: 'FAIL',
          error: 'Camera is not available. Paste the pair code or identity key instead.',
        })
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
            send({ type: 'CAMERA_READY' })
            scheduleNativeScan()
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
          send({ type: 'FAIL', error: 'Camera access was denied. Paste the code instead.' })
        } else if (/NotFound|DevicesNotFound/i.test(msg)) {
          send({ type: 'FAIL', error: 'No camera found. Paste the code instead.' })
        } else {
          send({
            type: 'FAIL',
            error: `${msg || 'Camera failed'}. Paste the code instead.`,
          })
        }
      }
    }

    void start()
    return () => {
      cancelled = true
      stopTracks()
    }
  }, [paused, send, snapshot.context.session])

  return (
    <div
      className="qr-scanner"
      data-aeon-scope="qr-scanner"
      data-aeon-state={snapshot.value}
    >
      <div className="qr-scanner-frame">
        <video
          ref={videoRef}
          className="qr-scanner-video"
          muted
          playsInline
          disablePictureInPicture
          aria-hidden={!ready}
        />
        {!ready && !error ? (
          <Skeleton className="qr-scanner-loading" width="100%" height="100%" radius={0} />
        ) : null}
        {ready ? <div className="qr-scanner-reticle" aria-hidden /> : null}
      </div>
      <p className="qr-scanner-hint">{error ?? (paused ? 'Camera paused' : hint)}</p>
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
