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
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import {
  composeBapIdentity,
  getBapProfile,
  previewBapId,
  type BapProfile,
} from '../wallet/bapIdentity'
import { CLAIM_HANDLE_URL } from '../wallet/walletConfig'
import { SkeletonQr } from './Skeleton'
import { CopyIcon } from './icons'

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
  const [bapId, setBapId] = useState<string | null>(null)
  const [published, setPublished] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [image, setImage] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

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

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const state = await getBapProfile()
        if (cancelled) return
        setPublished(state.published)
        setBapId(state.bapId)
        const p = state.profile
        if (p) {
          setName(typeof p.name === 'string' ? p.name : '')
          setDescription(typeof p.description === 'string' ? p.description : '')
          setImage(typeof p.image === 'string' ? p.image : '')
        } else {
          const preview = await previewBapId()
          if (!cancelled) setBapId(preview)
        }
      } catch (err) {
        if (!cancelled) {
          try {
            const preview = await previewBapId()
            setBapId(preview)
          } catch {
            /* locked */
          }
          setStatus(err instanceof Error ? err.message : String(err))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [profile.identityKey])

  const handleLabel = claimed ? formatHandCashHandle(claimed.handle, null) : null

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

  const onCompose = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      toastError('Identity', 'Add a display name first.')
      return
    }
    setBusy(true)
    setStatus(null)
    playWalletSound('soft')
    const profilePayload: BapProfile = {
      '@type': 'Person',
      name: trimmed,
    }
    if (description.trim()) profilePayload.description = description.trim()
    if (image.trim()) profilePayload.image = image.trim()

    const result = await composeBapIdentity(profilePayload)
    setBusy(false)
    if (!result.ok) {
      toastError('Compose identity', result.error)
      setStatus(result.error)
      return
    }
    setPublished(true)
    setBapId(result.bapId)
    setStatus(
      result.createdIdentity
        ? `Published BAP + profile · ${result.txid.slice(0, 10)}…`
        : `Updated profile · ${result.txid.slice(0, 10)}…`,
    )
    toastSuccess(
      result.createdIdentity ? 'Identity published' : 'Profile updated',
      result.bapId,
    )
  }

  return (
    <div className="nav-section-body identity-nav nav-section-with-scroll" data-aeon-scope="identity">
      <div className="connected-panel-head">
        <h2>Identity</h2>
      </div>
      <div className="identity-scroll nav-section-scroll-body">
        <div className="identity-body">
          <section className="identity-card" aria-label="Wallet identity">
            <div className="identity-hero">
              <div className="identity-qr">
                <div className="identity-qr-frame">
                  {dataUrl ? (
                    <img src={dataUrl} alt="Identity QR" width={160} height={160} />
                  ) : (
                    <SkeletonQr />
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost identity-copy-btn"
                  onClick={() => void copyIdentity()}
                >
                  <CopyIcon size={14} />
                  Copy identity key
                </button>
              </div>
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
                        Claim handle
                      </button>
                    </div>
                  )}
                </div>
                <p className="identity-qr-hint">
                  Scan to pay or add as a friend. Identity is per active wallet account.
                </p>
              </div>
            </div>

            <ul className="identity-list">
              <li className="identity-field identity-key-row">
                <span className="identity-field-label">Identity key</span>
                <button
                  type="button"
                  className="mono identity-key"
                  title={`Click to copy identity key
${profile.identityKey}`}
                  onClick={() => void copyIdentity()}
                >
                  <span>{shortIdentityKey(profile.identityKey)}</span>
                  <CopyIcon size={14} />
                </button>
              </li>
              <li className="identity-field">
                <span className="identity-field-label">Network</span>
                <strong className="identity-network" data-network={profile.chain}>
                  {profile.chain === 'main' ? 'Bitcoin SV Mainnet' : 'Bitcoin SV Testnet'}
                </strong>
              </li>
              <li className="identity-field">
                <span className="identity-field-label">BAP ID</span>
                <strong className="mono identity-bap-id">
                  {bapId ? shortIdentityKey(bapId) : '—'}
                  {published ? '' : ' (not published yet)'}
                </strong>
              </li>
            </ul>
          </section>

          <section className="identity-card identity-compose" aria-label="Compose BAP identity">
            <h3 className="identity-compose-title">Compose identity</h3>
            <p className="identity-compose-lede">
              Publishes your BAP ID (first time) and ALIAS profile on-chain for this wallet
              account. Needs a little spendable balance for fees.
            </p>
            <label className="identity-compose-field">
              <span>Display name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name"
                autoComplete="nickname"
                disabled={busy}
              />
            </label>
            <label className="identity-compose-field">
              <span>About</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Short bio"
                rows={3}
                disabled={busy}
              />
            </label>
            <label className="identity-compose-field">
              <span>Image URL</span>
              <input
                value={image}
                onChange={(e) => setImage(e.target.value)}
                placeholder="https://…"
                inputMode="url"
                disabled={busy}
              />
            </label>
            <button
              type="button"
              className="btn btn-primary identity-compose-submit"
              disabled={busy}
              onClick={() => void onCompose()}
            >
              {busy ? 'Publishing…' : published ? 'Update profile' : 'Publish identity'}
            </button>
            {status ? <p className="identity-compose-status">{status}</p> : null}
          </section>
        </div>
      </div>
    </div>
  )
}
