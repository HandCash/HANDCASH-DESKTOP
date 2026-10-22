import { Button } from '@aeon-ui/react'
import { PublicIdentitiesPanel } from './PublicIdentitiesPanel'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { WalletProfile } from '../machines/appMachine'
import { copyText } from '../wallet/clipboard'
import {
  claimedHandleForIdentity,
  releaseCloudHandle,
  subscribeClaimedCloudHandle,
  type ClaimedHandleState,
} from '../wallet/handleClaim'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { formatHandCashHandle } from '../wallet/handleFormat'
import { identityQrDataUrl, peekIdentityQrDataUrl } from '../wallet/identityQr'
import { toastError } from '../wallet/toast'
import { identityProfilesGeneration, subscribeIdentityProfiles } from '../wallet/identityProfiles'
import { issuerIdentitiesGeneration, subscribeIssuerIdentities } from '../wallet/issuerIdentities'
import {
  listPublicIdentities,
  publicIdentitiesGeneration,
  subscribePublicIdentities,
} from '../wallet/publicIdentities'
import { getWalletRuntime } from '../wallet/walletRuntime'
import { CLAIM_HANDLE_URL } from '../wallet/walletConfig'
import { SkeletonQr } from './Skeleton'
import { CopyIcon } from './icons'
import { ProfileIdenticon } from './ProfileIdenticon'

type Props = {
  profile: WalletProfile
}

function shortIdentityKey(key: string): string {
  const k = key.trim()
  if (k.length <= 20) return k
  return `${k.slice(0, 10)}…${k.slice(-8)}`
}

export function IdentityPanel({ profile }: Props) {
  const [dataUrl, setDataUrl] = useState(() =>
    peekIdentityQrDataUrl(profile.identityKey),
  )
  const [claimed, setClaimed] = useState<ClaimedHandleState | null>(() =>
    claimedHandleForIdentity(profile.identityKey),
  )
  const action = useAsyncAction<'release'>()
  const [releaseOpen, setReleaseOpen] = useState(false)
  const [forwardTo, setForwardTo] = useState('')
  const identities = useSyncExternalStore(subscribePublicIdentities, publicIdentitiesGeneration)
  const profiles = useSyncExternalStore(subscribeIdentityProfiles, identityProfilesGeneration)
  const packages = useSyncExternalStore(subscribeIssuerIdentities, issuerIdentitiesGeneration)
  /** Only a BAP profile has an ID apart from the wallet key. */
  const bapProfileId = useMemo(() => {
    try {
      const row = listPublicIdentities(getWalletRuntime()).find((entry) => entry.signer === 'wallet')
      return row?.profile?.source === 'bap' ? row.profile.id : null
    } catch {
      return null
    }
  }, [identities, profiles, packages, profile.identityKey])

  useEffect(() => {
    let cancelled = false
    void identityQrDataUrl(profile.identityKey)
      .then((url) => {
        if (!cancelled) setDataUrl(url)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          toastError(
            'QR failed',
            err instanceof Error ? err.message : String(err),
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [profile.identityKey])

  useEffect(() => {
    const refresh = () =>
      setClaimed(claimedHandleForIdentity(profile.identityKey))
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
    await copyText(profile.identityKey, { label: 'wallet key' })
  }

  const copyHandle = async () => {
    if (!claimed) return
    await copyText(claimed.display, { label: 'handle' })
  }

  const openClaim = () => {
    void window.handcash?.openExternal?.(CLAIM_HANDLE_URL)
  }

  const release = async () => {
    if (!handleLabel) return
    const target = forwardTo.trim()
    const outcome = await action.run('release', () => releaseCloudHandle({ forwardTo: target }))
    if (outcome.ok) {
      setReleaseOpen(false)
      setForwardTo('')
    } else if (outcome.error !== null) {
      toastError('Release failed', outcome.error)
    }
  }

  return (
    <div
      className="nav-section-body identity-nav nav-section-with-scroll"
      data-aeon-scope="identity"
    >
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
                    <img
                      src={dataUrl}
                      alt="Identity QR"
                      width={160}
                      height={160}
                    />
                  ) : (
                    <SkeletonQr />
                  )}
                </div>
                <Button.Root variant="ghost"
                  className="btn btn-ghost identity-copy-btn"
                  onClick={() => void copyIdentity()}
                >
                  <CopyIcon size={14} />
                  Copy wallet key
                </Button.Root>
              </div>
              <div className="identity-hero-meta">
                <div className="identity-field">
                  <span className="identity-field-label">Handle</span>
                  {handleLabel ? (
                    <div className="identity-handle-empty" data-aeon-part="handle" data-aeon-state={action.stateAttr}>
                      <button
                        type="button"
                        className="identity-handle"
                        title={`Click to copy ${handleLabel}`}
                        onClick={() => void copyHandle()}
                      >
                        {handleLabel}
                      </button>
                      {releaseOpen ? (
                        <>
                          <p className="identity-handle-missing">
                            Anyone can claim {handleLabel} after you release it, and payments to it stop reaching this
                            wallet. A new handle you name here is signed by this wallet; friends still confirm it with
                            you first.
                          </p>
                          <label className="field">
                            <span className="field-label">Moving to another handle? (optional)</span>
                            <input
                              className="input"
                              placeholder="@name@domain"
                              autoComplete="off"
                              spellCheck={false}
                              value={forwardTo}
                              disabled={action.busy}
                              onChange={(e) => setForwardTo(e.target.value)}
                            />
                          </label>
                          <div className="auth-actions">
                            <Button.Root variant="ghost"
                              className="btn btn-ghost identity-claim-btn"
                              disabled={action.busy}
                              onClick={() => void release()}
                            >
                              <Button.Label>{action.running('release') ? 'Releasing…' : 'Release'}</Button.Label>
                            </Button.Root>
                            <Button.Root variant="ghost"
                              className="btn btn-ghost identity-claim-btn"
                              disabled={action.busy}
                              onClick={() => setReleaseOpen(false)}
                            >
                              <Button.Label>Cancel</Button.Label>
                            </Button.Root>
                          </div>
                        </>
                      ) : (
                        <Button.Root variant="ghost"
                          className="btn btn-ghost identity-claim-btn"
                          onClick={() => setReleaseOpen(true)}
                        >
                          <Button.Label>Release handle</Button.Label>
                        </Button.Root>
                      )}
                    </div>
                  ) : (
                    <div className="identity-handle-empty">
                      <p className="identity-handle-missing">
                        No handle claimed yet
                      </p>
                      <Button.Root variant="ghost"
                        className="btn btn-ghost identity-claim-btn"
                        onClick={openClaim}
                      >
                        <Button.Label>Claim handle</Button.Label>
                      </Button.Root>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <ul className="identity-list">
              <li className="identity-field identity-key-row">
                <span className="identity-field-label">Wallet key</span>
                <button
                  type="button"
                  className="mono identity-key"
                  title={`Click to copy wallet key
${profile.identityKey}`}
                  onClick={() => void copyIdentity()}
                >
                  <span>{shortIdentityKey(profile.identityKey)}</span>
                  <CopyIcon size={14} />
                </button>
              </li>
              <li className="identity-field">
                <span className="identity-field-label">Network</span>
                <strong
                  className="identity-network"
                  data-network={profile.chain}
                >
                  {profile.chain === 'main'
                    ? 'Bitcoin SV Mainnet'
                    : 'Bitcoin SV Testnet'}
                </strong>
              </li>
              {bapProfileId ? (
                <li className="identity-field">
                  <span className="identity-field-label">Profile ID</span>
                  <strong className="mono identity-bap-id" title={bapProfileId}>
                    <ProfileIdenticon id={bapProfileId} />
                    {shortIdentityKey(bapProfileId)}
                  </strong>
                </li>
              ) : null}
            </ul>
            <p className="identity-note">
              {bapProfileId
                ? 'People pay your wallet key. Your profile ID is the public name they check: a copycat can borrow your name and picture, never this ID.'
                : 'People pay your wallet key, and your profile is signed by it: a copycat can borrow your name and picture, never this key.'}
            </p>
          </section>

          <PublicIdentitiesPanel
            key={`${profile.chain}:${profile.identityKey}`}
            profile={profile}
          />
        </div>
      </div>
    </div>
  )
}
