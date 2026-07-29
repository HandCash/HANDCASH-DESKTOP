import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { stateToAttr } from '@aeon-ui/core'
import { ModalPortal } from './ModalPortal'

type Props = {
  label: string
  value: string
  subtitle?: string
  open: boolean
  onClose: () => void
}

function defaultSubtitle(label: string): string {
  const key = label.trim().toLowerCase()
  if (key === 'identity') return 'Scan to share this identity key'
  if (key === 'receive') return 'Scan to send BSV to this wallet'
  return 'Scan or tap below to copy'
}

export function QrDialog({ label, value, subtitle, open, onClose }: Props) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'success' | 'failure' | 'empty'>('empty')
  const [copied, setCopied] = useState(false)
  const title = label.trim() || 'QR'
  const hint = subtitle ?? defaultSubtitle(title)

  useEffect(() => {
    if (!open) {
      setDataUrl(null)
      setError(null)
      setStatus('empty')
      setCopied(false)
      return
    }
    let cancelled = false
    setStatus('loading')
    void QRCode.toDataURL(value, {
      width: 240,
      margin: 2,
      color: { dark: '#000000', light: '#FFFFFF' },
      errorCorrectionLevel: 'M',
    })
      .then((url) => {
        if (cancelled) return
        setDataUrl(url)
        setStatus('success')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setStatus('failure')
      })
    return () => {
      cancelled = true
    }
  }, [open, value])

  if (!open) return null

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
    <ModalPortal>
      <div
        className="modal-backdrop"
        data-aeon-scope="dialog"
        data-aeon-state={stateToAttr(status)}
        onClick={onClose}
        role="presentation"
      >
        <div
          className="panel modal qr-modal"
          data-aeon-part="content"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label={title}
        >
          <h2>{title}</h2>
          <p className="qr-subtitle">{hint}</p>

          {status === 'loading' && <p className="lede">Generating QR…</p>}
          {status === 'failure' && <p className="error">{error}</p>}
          {status === 'success' && dataUrl && (
            <div className="qr-frame" data-aeon-part="media">
              <img src={dataUrl} alt={`${title} QR code`} width={240} height={240} />
            </div>
          )}

          <button
            type="button"
            className={`mono qr-value${copied ? ' is-copied' : ''}`}
            title="Click to copy"
            onClick={() => void copy()}
          >
            {copied ? 'Copied' : value}
          </button>

          <div className="actions qr-actions">
            <button className="btn btn-primary" type="button" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}
