import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { DeferredImage } from './DeferredImage'
import { SkeletonQr } from './Skeleton'

type Props = {
  value: string
  subtitle?: string
}

export function ReceivePanel({
  value,
  subtitle = 'Scan to send BSV to this wallet',
}: Props) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    setError(null)
    setDataUrl(null)
    void QRCode.toDataURL(value, {
      width: 220,
      margin: 2,
      color: { dark: '#000000', light: '#FFFFFF' },
      errorCorrectionLevel: 'M',
    })
      .then((url) => {
        if (!cancelled) setDataUrl(url)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [value])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // ignore
    }
  }

  return (
    <div className="nav-child-panel receive-panel" data-aeon-scope="receive">
      <p className="qr-subtitle">{subtitle}</p>
      {error && <p className="error">{error}</p>}
      <div className="qr-frame" data-aeon-part="media">
        {dataUrl ? (
          <DeferredImage
            src={dataUrl}
            alt="Receive address QR code"
            width={220}
            height={220}
            skeletonWidth={220}
            skeletonHeight={220}
            skeletonRadius={4}
            skeletonClassName="skeleton-qr"
          />
        ) : !error ? (
          <SkeletonQr size={220} />
        ) : null}
      </div>
      <button
        type="button"
        className={`mono qr-value${copied ? ' is-copied' : ''}`}
        title="Click to copy"
        onClick={() => void copy()}
      >
        {copied ? 'Copied' : value}
      </button>
    </div>
  )
}
