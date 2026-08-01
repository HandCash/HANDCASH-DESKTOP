import { useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import { copyText } from '../wallet/clipboard'
import { buildPeerPayUri } from '../wallet/peerPayUri'
import { toastError } from '../wallet/toast'
import { DeferredImage } from './DeferredImage'
import { SkeletonQr } from './Skeleton'

type ReceiveMode = 'peerpay' | 'address'

type Props = {
  address: string
  identityKey: string
}

export function ReceivePanel({ address, identityKey }: Props) {
  const [mode, setMode] = useState<ReceiveMode>('peerpay')
  const [dataUrl, setDataUrl] = useState<string | null>(null)

  const peerpayUri = useMemo(() => {
    try {
      return buildPeerPayUri(identityKey)
    } catch {
      return null
    }
  }, [identityKey])

  const value = mode === 'peerpay' && peerpayUri ? peerpayUri : address
  const subtitle =
    mode === 'peerpay'
      ? 'PeerPay (BRC-125) — identity key payment link'
      : 'Payment address — scan or copy to receive BSV'

  useEffect(() => {
    let cancelled = false
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
        if (!cancelled) {
          toastError('QR failed', err instanceof Error ? err.message : String(err))
        }
      })
    return () => {
      cancelled = true
    }
  }, [value])

  const copy = async () => {
    await copyText(value, { label: mode === 'peerpay' ? 'PeerPay link' : 'address' })
  }

  return (
    <div className="nav-child-panel receive-panel" data-aeon-scope="receive">
      <div className="receive-layout">
        <div className="receive-qr" data-aeon-part="media">
          <button
            type="button"
            className="qr-frame receive-qr-frame"
            title="Click to copy"
            onClick={() => void copy()}
          >
            {dataUrl ? (
              <DeferredImage
                src={dataUrl}
                alt={mode === 'peerpay' ? 'PeerPay QR code' : 'Receive address QR code'}
                width={220}
                height={220}
                skeletonWidth={220}
                skeletonHeight={220}
                skeletonRadius={4}
                skeletonClassName="skeleton-qr"
              />
            ) : (
              <SkeletonQr size={220} />
            )}
          </button>
          <p className="receive-qr-hint">Tap QR to copy</p>
        </div>

        <div className="receive-info">
          {peerpayUri ? (
            <div className="actions receive-mode-actions" style={{ marginBottom: 12 }}>
              <button
                type="button"
                className={mode === 'peerpay' ? 'btn btn-primary' : 'btn btn-ghost'}
                onClick={() => setMode('peerpay')}
              >
                PeerPay
              </button>
              <button
                type="button"
                className={mode === 'address' ? 'btn btn-primary' : 'btn btn-ghost'}
                onClick={() => setMode('address')}
              >
                Address
              </button>
            </div>
          ) : null}
          <p className="qr-subtitle receive-subtitle">{subtitle}</p>
          <button
            type="button"
            className="mono qr-value receive-address"
            title="Click to copy"
            onClick={() => void copy()}
          >
            {value}
          </button>
          <div className="actions receive-actions">
            <button type="button" className="btn btn-primary" onClick={() => void copy()}>
              {mode === 'peerpay' ? 'Copy PeerPay' : 'Copy address'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
