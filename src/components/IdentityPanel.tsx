import { useEffect, useState } from 'react'
import type { WalletProfile } from '../machines/appMachine'
import { copyText } from '../wallet/clipboard'
import {
  claimedHandleForIdentity,
  subscribeClaimedCloudHandle,
  type ClaimedHandleState,
} from '../wallet/handleClaim'
import { formatHandCashHandle } from '../wallet/handleFormat'
import { identityQrDataUrl, peekIdentityQrDataUrl } from '../wallet/identityQr'
import { toastError } from '../wallet/toast'
import { CLAIM_HANDLE_URL } from '../wallet/walletConfig'
import { SkeletonQr } from './Skeleton'

type Props = {
  profile: WalletProfile
}

function shortIdentityKey(key: string): string {
  const k = key.trim()
  if (k.length <= 20) return k
  return `${k.slice(0, 10)}…${k.slice(-8)}`
}

export function IdentityPanel({ profile }: Props) {
  const [dataUrl, setDataUrl] = useState(() => peekIdentityQrDataUrl(profile.identityKey))
  const [claimed, setClaimed] = useState<ClaimedHandleState | null>(() =>
    claimedHandleForIdentity(profile.identityKey),
  )

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

  useEffect(() => {
    const refresh = () => setClaimed(claimedHandleForIdentity(profile.identityKey))
    refresh()
    const unsub = subscribeClaimedCloudHandle(refresh)
    const onVis = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', refresh)
    return () => {
      unsub()
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', refresh)
    }
  }, [profile.identityKey])

  const handleLabel = claimed
    ? formatHandCashHandle(claimed.handle, null)
    : null

  const copyIdentity = async () => {
    await copyText(profile.identityKey, { label: 'identity key' })
  }

  const copyHandle = async () => {
    if (!claimed) return
    await copyText(handleLabel || claimed.display, { label: 'handle' })
  }

  const openClaim = () => {
    void window.handcash?.openExternal?.(CLAIM_HANDLE_URL)
  }

  return (
    <div className="nav-section-body identity-nav identity-scroll" data-aeon-scope="identity">
      <div className="connected-panel-head">
        <h2>Identity</h2>
      </div>

      <div className="identity-body">
        <div className="identity-hero">
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
                width={140}
                height={140}
                decoding="async"
              />
            ) : (
              <SkeletonQr size={140} />
            )}
          </button>

          <div className="identity-hero-meta">
            <div className="identity-field">
              <span className="identity-field-label">Handle</span>
              {handleLabel ? (
                <button
                  type="button"
                  className="identity-handle"
                  title={`Click to copy ${handleLabel}`}
                  onClick={() => void copyHandle()}
                >
                  {handleLabel}
                </button>
              ) : (
                <div className="identity-handle-empty">
                  <p className="identity-handle-missing">No handle claimed yet</p>
                  <button type="button" className="btn btn-ghost identity-claim-btn" onClick={openClaim}>
                    Claim your $handle
                  </button>
                </div>
              )}
            </div>
            <p className="identity-qr-hint">Tap QR to copy identity key</p>
          </div>
        </div>

        <ul className="identity-list">
          <li className="identity-field">
            <span className="identity-field-label">Identity key</span>
            <button
              type="button"
              className="mono identity-key"
              title={`Click to copy identity key\n${profile.identityKey}`}
              onClick={() => void copyIdentity()}
            >
              {shortIdentityKey(profile.identityKey)}
            </button>
          </li>

          <li className="identity-field">
            <span className="identity-field-label">Network</span>
            <strong className="identity-network">
              {profile.chain === 'main' ? 'Bitcoin SV Mainnet' : 'Bitcoin SV Testnet'}
            </strong>
          </li>
        </ul>

        <p className="identity-key-note">
          Your identity key is not a payment address — use Receive for BSV.
        </p>
      </div>
    </div>
  )
}
