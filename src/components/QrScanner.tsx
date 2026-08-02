import { useEffect, useRef, useState } from 'react'
import { Html5Qrcode } from 'html5-qrcode'

type Props = {
  onScan: (text: string) => void
  active?: boolean
}

/** Camera QR scanner for Desktop / renderer (html5-qrcode). */
export function QrScanner({ onScan, active = true }: Props) {
  const [error, setError] = useState<string | null>(null)
  const handled = useRef(false)
  const onScanRef = useRef(onScan)
  onScanRef.current = onScan

  useEffect(() => {
    if (!active) return
    handled.current = false
    const id = 'hc-desktop-qr-reader'
    const scanner = new Html5Qrcode(id)
    let cancelled = false

    const isMobile =
      typeof document !== 'undefined' &&
      (document.documentElement.classList.contains('platform-mobile') ||
        window.handcash?.platform === 'android' ||
        window.handcash?.platform === 'ios')
    // Phones: rear camera for scanning another screen. Desktop webcams: front.
    const facingMode = isMobile ? 'environment' : 'user'

    void scanner
      .start(
        { facingMode },
        { fps: 8, qrbox: { width: 240, height: 240 } },
        (text) => {
          if (handled.current || cancelled) return
          handled.current = true
          onScanRef.current(text)
        },
        () => undefined,
      )
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Camera unavailable')
      })

    return () => {
      cancelled = true
      void scanner.stop().catch(() => undefined)
    }
  }, [active])

  return (
    <div className="qr-scanner">
      <div id="hc-desktop-qr-reader" className="qr-scanner-view" />
      {error ? <p className="settings-hint">{error}. You can paste a link payload instead.</p> : null}
    </div>
  )
}
