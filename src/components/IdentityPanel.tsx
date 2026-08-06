import { useEffect, useState } from 'react'
import type { WalletProfile } from '../machines/appMachine'
import { copyText } from '../wallet/clipboard'
import { identityQrDataUrl, peekIdentityQrDataUrl } from '../wallet/identityQr'
import { toastError } from '../wallet/toast'
import { SkeletonQr } from './Skeleton'

type Props = {
  profile: WalletProfile
}

export function IdentityPanel({ profile }: Props) {
  const [dataUrl, setDataUrl] = useState(() => peekIdentityQrDataUrl(profile.identityKey))

  useEffect(() => {
    let cancelled = false
    void identityQrDataUrl(profile.identityKey)
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
  }, [profile.identityKey])

  const copyIdentity = async () => {
    await copyText(profile.identityKey, { label: 'identity key' })
  }

  return (
    <div className="nav-section-body identity-nav" data-aeon-scope="identity">
      <div className="connected-panel-head">
        <h2>Identity</h2>
      </div>

      <div className="identity-layout">
        <div className="identity-qr" data-aeon-part="media">
          <button
            type="button"
            className="identity-qr-frame identity-qr-copy"
            title="Click to copy identity key"
            onClick={() => void copyIdentity()}
          >
            {dataUrl ? (
              <img
                src={dataUrl}
                alt="Identity key QR code"
                width={180}
                height={180}
                decoding="async"
              />
            ) : (
              <SkeletonQr size={180} />
            )}
          </button>
          <p className="identity-qr-hint">Tap QR to copy</p>
          <p className="identity-key-note">
            Identity key — not a payment address. Use Receive for BSV. Same phrase on another
            device is the same pot (Settings → Use on another device).
          </p>
        </div>

        <div className="identity-info">
          <div className="identity-nav-row">
            <span>Identity key</span>
            <button
              type="button"
              className="mono identity-key"
              title="Click to copy identity key"
              onClick={() => void copyIdentity()}
            >
              {profile.identityKey}
            </button>
          </div>
          <div className="identity-nav-row">
            <span>Network</span>
            <strong className="identity-network">
              {profile.chain === 'main' ? 'Bitcoin SV Mainnet' : 'Bitcoin SV Testnet'}
            </strong>
          </div>
        </div>
      </div>
    </div>
  )
}
