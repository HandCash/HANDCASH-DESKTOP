import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { WalletProfile } from '../machines/appMachine'
import { DeferredImage } from './DeferredImage'
import { SkeletonQr } from './Skeleton'

type Props = {
  profile: WalletProfile
}

export function IdentityPanel({ profile }: Props) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    setError(null)
    void QRCode.toDataURL(profile.identityKey, {
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
  }, [profile.identityKey])

  const copyIdentity = async () => {
    try {
      await navigator.clipboard.writeText(profile.identityKey)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // ignore
    }
  }

  return (
    <div className="nav-section-body identity-nav" data-aeon-scope="identity">
      <div className="connected-panel-head">
        <h2>Identity</h2>
      </div>

      <div className="identity-layout">
        <div className="identity-qr" data-aeon-part="media">
          {error ? <p className="error">{error}</p> : null}
          <div className="identity-qr-frame">
            {dataUrl ? (
              <DeferredImage
                src={dataUrl}
                alt="Identity key QR code"
                width={180}
                height={180}
                skeletonWidth={180}
                skeletonHeight={180}
                skeletonRadius={4}
                skeletonClassName="skeleton-qr"
              />
            ) : !error ? (
              <SkeletonQr size={180} />
            ) : null}
          </div>
          <p className="identity-qr-hint">Scan to share this identity key</p>
        </div>

        <div className="identity-info">
          <div className="identity-nav-row">
            <span>Identity key</span>
            <button
              type="button"
              className={`mono wallet-detail-value${copied ? ' is-copied' : ''}`}
              title="Click to copy identity"
              onClick={() => void copyIdentity()}
            >
              {copied ? 'Copied' : profile.identityKey}
            </button>
          </div>
          <div className="identity-nav-row">
            <span>Network</span>
            <strong className="identity-nav-network">
              {profile.chain === 'main' ? 'Mainnet' : 'Testnet'}
            </strong>
          </div>
        </div>
      </div>
    </div>
  )
}
