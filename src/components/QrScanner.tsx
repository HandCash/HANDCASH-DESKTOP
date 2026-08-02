import { useEffect, useRef, useState } from 'react'
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode'

type Props = {
  onScan: (text: string) => void
  active?: boolean
}

function isMobilePlatform(): boolean {
  if (typeof document === 'undefined') return false
  return (
    document.documentElement.classList.contains('platform-mobile') ||
    window.handcash?.platform === 'android' ||
    window.handcash?.platform === 'ios'
  )
}

function barcodeDetectorSupported(): boolean {
  return typeof BarcodeDetector === 'function'
}

const VIDEO_CONSTRAINTS = {
  width: { ideal: 1280, max: 1280 },
  height: { ideal: 720, max: 720 },
  frameRate: { ideal: 24, max: 30 },
} as const

/** Prefer native BarcodeDetector; fall back to html5-qrcode (QR-only, capped resolution). */
export function QrScanner({ onScan, active = true }: Props) {
  const [error, setError] = useState<string | null>(null)
  const [useNativeUi, setUseNativeUi] = useState(() => barcodeDetectorSupported())
  const handled = useRef(false)
  const onScanRef = useRef(onScan)
  onScanRef.current = onScan
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!active) return
    handled.current = false
    setError(null)
    setUseNativeUi(barcodeDetectorSupported())
    let cancelled = false
    let cleanup: (() => void) | undefined

    const deliver = (text: string) => {
      const value = text.trim()
      if (handled.current || cancelled || !value) return
      handled.current = true
      onScanRef.current(value)
    }

    const startNative = async () => {
      const video = videoRef.current
      if (!video || !barcodeDetectorSupported()) throw new Error('native unavailable')

      const mobile = isMobilePlatform()
      const facingMode = mobile ? 'environment' : 'user'
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: facingMode },
          ...VIDEO_CONSTRAINTS,
        },
      })
      if (cancelled) {
        for (const track of stream.getTracks()) track.stop()
        return
      }

      video.srcObject = stream
      video.setAttribute('playsinline', 'true')
      video.muted = true
      await video.play()

      const track = stream.getVideoTracks()[0]
      if (track?.applyConstraints) {
        try {
          await track.applyConstraints({
            advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet],
          })
        } catch {
          // unsupported on some devices
        }
      }

      const detector = new BarcodeDetector({ formats: ['qr_code'] })
      let busy = false
      let raf = 0
      let lastAttempt = 0

      const tick = (now: number) => {
        if (cancelled) return
        raf = requestAnimationFrame(tick)
        if (busy || now - lastAttempt < 80) return
        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
        lastAttempt = now
        busy = true
        void detector
          .detect(video)
          .then((codes) => {
            const value = codes[0]?.rawValue
            if (value) deliver(value)
          })
          .catch(() => undefined)
          .finally(() => {
            busy = false
          })
      }
      raf = requestAnimationFrame(tick)

      cleanup = () => {
        cancelAnimationFrame(raf)
        for (const t of stream.getTracks()) t.stop()
        video.srcObject = null
      }
    }

    const startHtml5 = async () => {
      setUseNativeUi(false)
      // Let React drop the native <video> before html5-qrcode mounts into the host.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      if (cancelled) return

      const host = hostRef.current
      if (!host) throw new Error('scanner host missing')
      host.replaceChildren()
      const id = `hc-qr-reader-${Math.random().toString(36).slice(2, 9)}`
      host.id = id

      const mobile = isMobilePlatform()
      const facingMode = mobile ? 'environment' : 'user'
      const scanner = new Html5Qrcode(id, {
        verbose: false,
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
        useBarCodeDetectorIfSupported: true,
      })

      await scanner.start(
        { facingMode },
        {
          fps: mobile ? 12 : 10,
          qrbox: (viewW, viewH) => {
            const edge = Math.floor(Math.min(viewW, viewH) * 0.75)
            return { width: Math.max(180, edge), height: Math.max(180, edge) }
          },
          disableFlip: mobile,
          videoConstraints: {
            facingMode,
            ...VIDEO_CONSTRAINTS,
          },
        },
        (text) => deliver(text),
        () => undefined,
      )

      cleanup = () => {
        void scanner
          .stop()
          .catch(() => undefined)
          .then(() => {
            try {
              scanner.clear()
            } catch {
              // ignore
            }
          })
      }
    }

    void (async () => {
      try {
        if (barcodeDetectorSupported()) {
          await startNative()
          return
        }
        await startHtml5()
      } catch (nativeErr) {
        if (cancelled) return
        console.warn('[qr] native scanner failed, falling back', nativeErr)
        try {
          cleanup?.()
          cleanup = undefined
          await startHtml5()
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : 'Camera unavailable')
          }
        }
      }
    })()

    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [active])

  return (
    <div className="qr-scanner">
      <div ref={hostRef} className="qr-scanner-view">
        {useNativeUi ? (
          <video ref={videoRef} className="qr-scanner-video" playsInline muted autoPlay />
        ) : null}
      </div>
      {error ? <p className="settings-hint">{error}. You can paste a link payload instead.</p> : null}
    </div>
  )
}
