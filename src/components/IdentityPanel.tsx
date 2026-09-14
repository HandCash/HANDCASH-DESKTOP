import { useEffect, useState } from 'react'
import { useMachine } from '@xstate/react'
import { ListRow, StatusBanner } from '@aeon-ui/react'
import { stateToAttr } from '@aeon-ui/core'
import type { WalletProfile } from '../machines/appMachine'
import { identityMachine } from '../machines/identityMachine'
import { copyText } from '../wallet/clipboard'
import {
  claimedHandleForIdentity,
  subscribeClaimedCloudHandle,
  type ClaimedHandleState,
} from '../wallet/handleClaim'
import { formatHandCashHandle } from '../wallet/handleFormat'
import { identityQrDataUrl, peekIdentityQrDataUrl } from '../wallet/identityQr'
import {
  listSigmaIdentities,
  personaIdFromName,
  publishSigmaIdentity,
  revokeSigmaIdentity,
  selectSigningSigmaIdentity,
  signingSigmaIdentity,
  subscribeSigmaIdentities,
  type SigmaPersonaRecord,
} from '../wallet/sigmaIdentity'
import { toastError } from '../wallet/toast'
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

function personaStatus(persona: SigmaPersonaRecord): string {
  if (persona.status === 'funding') return 'Funding'
  if (persona.status === 'revoked') return 'Revoked'
  return 'Active'
}

export function IdentityPanel({ profile }: Props) {
  const [snapshot, send] = useMachine(identityMachine)
  const screen = stateToAttr(snapshot.value)
  const [dataUrl, setDataUrl] = useState(() => peekIdentityQrDataUrl(profile.identityKey))
  const [claimed, setClaimed] = useState<ClaimedHandleState | null>(() =>
    claimedHandleForIdentity(profile.identityKey),
  )
  const [personas, setPersonas] = useState<SigmaPersonaRecord[]>(() =>
    listSigmaIdentities(profile.identityKey),
  )
  const [signingId, setSigningId] = useState(
    () => signingSigmaIdentity(profile.identityKey)?.id ?? '',
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

  useEffect(() => {
    const refresh = () => {
      setPersonas(listSigmaIdentities(profile.identityKey))
      setSigningId(signingSigmaIdentity(profile.identityKey)?.id ?? '')
    }
    refresh()
    return subscribeSigmaIdentities(refresh)
  }, [profile.identityKey])

  const handleLabel = claimed ? formatHandCashHandle(claimed.handle, null) : null
  const draftId = personaIdFromName(snapshot.context.name)
  const revoking = personas.find((row) => row.id === snapshot.context.personaId) ?? null
  const brc169State = claimed ? 'claimed' : 'unclaimed'

  const copyIdentity = async () => {
    await copyText(profile.identityKey, { label: 'identity key' })
  }

  const copyHandle = async () => {
    if (!claimed) return
    await copyText(handleLabel || claimed.display, { label: 'handle' })
  }

  const publish = async () => {
    send({ type: 'CONFIRM' })
    try {
      await publishSigmaIdentity({
        name: snapshot.context.name,
        about: snapshot.context.about,
      })
      send({ type: 'SUCCESS' })
    } catch (err) {
      send({
        type: 'FAIL',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const revoke = async () => {
    const id = snapshot.context.personaId
    if (!id) return
    send({ type: 'CONFIRM' })
    try {
      await revokeSigmaIdentity(id)
      send({ type: 'SUCCESS' })
    } catch (err) {
      send({
        type: 'FAIL',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <div
      className="nav-section-body identity-nav nav-section-with-scroll"
      data-aeon-scope="identity"
      data-aeon-state={screen}
    >
      <div className="connected-panel-head">
        <h2>Identity</h2>
      </div>
      <div className="identity-scroll nav-section-scroll-body">
        <div className="identity-body">
          <section
            className="identity-card"
            data-aeon-part="root"
            data-aeon-state="ready"
            aria-label="Root identity"
          >
            <div className="identity-kind">
              <span className="identity-kind-label">Root identity</span>
              <p className="identity-kind-note">
                BRC-100 wallet key. Apps prove this key. It is not a Sigma persona.
              </p>
            </div>
            <div className="identity-hero">
              <div className="identity-qr">
                <div className="identity-qr-frame">
                  {dataUrl ? (
                    <img
                      src={dataUrl}
                      alt="Root identity key QR code"
                      width={140}
                      height={140}
                      decoding="async"
                    />
                  ) : (
                    <SkeletonQr size={140} />
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost identity-copy-btn"
                  onClick={() => void copyIdentity()}
                >
                  <CopyIcon size={16} />
                  Copy root key
                </button>
              </div>
              <div className="identity-hero-meta">
                <p className="identity-qr-hint">
                  Scan this to share the wallet key, not a Sigma signing key.
                </p>
              </div>
            </div>
            <ul className="identity-list">
              <li className="identity-field identity-key-row">
                <span className="identity-field-label">Root identity key</span>
                <button
                  type="button"
                  className="mono identity-key"
                  title={`Click to copy identity key\n${profile.identityKey}`}
                  onClick={() => void copyIdentity()}
                >
                  <span>{shortIdentityKey(profile.identityKey)}</span>
                  <CopyIcon size={15} />
                </button>
              </li>
              <li className="identity-field">
                <span className="identity-field-label">Network</span>
                <strong className="identity-network" data-network={profile.chain}>
                  {profile.chain === 'main' ? 'Bitcoin SV Mainnet' : 'Bitcoin SV Testnet'}
                </strong>
              </li>
            </ul>
          </section>

          <section
            className="identity-card identity-part"
            data-aeon-part="brc169"
            data-aeon-state={brc169State}
            aria-label="BRC-169 handle"
          >
            <div className="identity-kind">
              <span className="identity-kind-label">BRC-169 handle</span>
              <p className="identity-kind-note">
                A $handle claimed on the root key. Claiming it does not create a Sigma identity.
              </p>
            </div>
            <div className="identity-field">
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
                  <button
                    type="button"
                    className="btn btn-ghost identity-claim-btn"
                    onClick={() => void window.handcash?.openExternal?.(CLAIM_HANDLE_URL)}
                  >
                    Claim your $handle
                  </button>
                </div>
              )}
            </div>
          </section>

          <section
            className="identity-card identity-part"
            data-aeon-part="sigma"
            data-aeon-state={screen}
            aria-label="Sigma identities"
          >
            <div className="identity-kind">
              <span className="identity-kind-label">Sigma identities</span>
              <p className="identity-kind-note">
                On-chain personas that sign 1Sat and BSV-21 issuances. Each lives in its own
                basket. Revoking spends that control output. The root key and the handle stay.
              </p>
            </div>

            {snapshot.matches('failure') && snapshot.context.error ? (
              <StatusBanner.Root tone="danger" status="failed">
                <StatusBanner.Copy>
                  <StatusBanner.Title>Could not update the Sigma identity</StatusBanner.Title>
                  <StatusBanner.Body>{snapshot.context.error}</StatusBanner.Body>
                </StatusBanner.Copy>
              </StatusBanner.Root>
            ) : null}

            {snapshot.matches('published') ? (
              <StatusBanner.Root tone="success" status="published">
                <StatusBanner.Copy>
                  <StatusBanner.Title>Sigma identity created</StatusBanner.Title>
                  <StatusBanner.Body>
                    The persona is inscribed and isolated from cash and collectables.
                  </StatusBanner.Body>
                </StatusBanner.Copy>
              </StatusBanner.Root>
            ) : null}

            {snapshot.matches('browsing') || snapshot.matches('published') || snapshot.matches('failure') ? (
              personas.length ? (
                <div className="identity-persona-list" data-aeon-part="list">
                  {personas.map((persona) => (
                    <ListRow.Root
                      key={persona.id}
                      className="identity-persona"
                      data-aeon-state={persona.status}
                    >
                      <span className="identity-persona-copy">
                        <ListRow.Label>{persona.name}</ListRow.Label>
                        <ListRow.Description>
                          {persona.id}
                          {persona.id === signingId && persona.status === 'active'
                            ? ' · Signing'
                            : ''}
                          {persona.about ? ` · ${persona.about}` : ''}
                        </ListRow.Description>
                      </span>
                      <ListRow.Trailing>{personaStatus(persona)}</ListRow.Trailing>
                    </ListRow.Root>
                  ))}
                </div>
              ) : snapshot.matches('browsing') ? (
                <p className="identity-kind-note">No Sigma identities yet.</p>
              ) : null
            ) : null}

            {snapshot.matches('browsing') ? (
              <div className="identity-persona-actions">
                {personas
                  .filter((persona) => persona.status === 'active')
                  .map((persona) => (
                    <span key={persona.id} className="identity-persona-actions">
                      {persona.id !== signingId ? (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() =>
                            selectSigningSigmaIdentity(profile.identityKey, persona.id)
                          }
                        >
                          Sign as {persona.name}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() =>
                          void copyText(persona.publicKey, { label: 'Sigma identity key' })
                        }
                      >
                        Copy {persona.name}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => send({ type: 'REVOKE', personaId: persona.id })}
                      >
                        Revoke {persona.name}
                      </button>
                    </span>
                  ))}
                <button type="button" className="btn btn-primary" onClick={() => send({ type: 'COMPOSE' })}>
                  Create Sigma identity
                </button>
              </div>
            ) : null}

            {snapshot.matches('composing') || snapshot.matches('confirming') ? (
              <form
                className="identity-sigma-form"
                data-aeon-part="form"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (snapshot.matches('composing')) send({ type: 'REVIEW' })
                  else void publish()
                }}
              >
                {snapshot.matches('composing') ? (
                  <>
                    <div className="field">
                      <label htmlFor="sigma-identity-name">Name</label>
                      <input
                        id="sigma-identity-name"
                        value={snapshot.context.name}
                        maxLength={40}
                        autoComplete="off"
                        placeholder="Name people should see"
                        onChange={(event) => send({ type: 'EDIT', name: event.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="sigma-identity-about">Context</label>
                      <input
                        id="sigma-identity-about"
                        value={snapshot.context.about}
                        maxLength={80}
                        autoComplete="off"
                        placeholder="Short description, not a URL"
                        onChange={(event) => send({ type: 'EDIT', about: event.target.value })}
                      />
                    </div>
                    {draftId ? (
                      <p className="identity-kind-note">
                        On-chain id {draftId}. Basket sigma-{draftId}.
                      </p>
                    ) : snapshot.context.name.trim() ? (
                      <p className="identity-kind-note">That name cannot become an id.</p>
                    ) : null}
                  </>
                ) : (
                  <p className="identity-kind-note">
                    Inscribe {snapshot.context.name}
                    {draftId ? ` as ${draftId}` : ''}. This spends a little BSV and does not change
                    the root key or the BRC-169 handle.
                  </p>
                )}
                <div className="identity-persona-actions">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => send({ type: snapshot.matches('confirming') ? 'BACK' : 'CANCEL' })}
                  >
                    {snapshot.matches('confirming') ? 'Back' : 'Cancel'}
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={snapshot.matches('composing') && !draftId}
                  >
                    {snapshot.matches('confirming') ? 'Inscribe' : 'Review'}
                  </button>
                </div>
              </form>
            ) : null}

            {snapshot.matches('publishing') || snapshot.matches('revoking') ? (
              <p className="identity-kind-note" data-aeon-state={screen}>
                {snapshot.matches('publishing')
                  ? 'Inscribing the Sigma identity…'
                  : 'Spending the control output…'}
              </p>
            ) : null}

            {snapshot.matches('revokeConfirm') ? (
              <form
                className="identity-sigma-form"
                data-aeon-part="revoke"
                onSubmit={(event) => {
                  event.preventDefault()
                  void revoke()
                }}
              >
                <p className="identity-kind-note">
                  Revoke {revoking?.name ?? snapshot.context.personaId}. The control output is
                  spent. The root key and the BRC-169 handle are not.
                </p>
                <div className="identity-persona-actions">
                  <button type="button" className="btn btn-ghost" onClick={() => send({ type: 'BACK' })}>
                    Back
                  </button>
                  <button type="submit" className="btn btn-danger">
                    Revoke
                  </button>
                </div>
              </form>
            ) : null}

            {snapshot.matches('published') || snapshot.matches('failure') ? (
              <div className="identity-persona-actions">
                {snapshot.matches('failure') ? (
                  <button type="button" className="btn btn-ghost" onClick={() => send({ type: 'BACK' })}>
                    Back
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => send({ type: snapshot.matches('published') ? 'DONE' : 'CANCEL' })}
                >
                  Done
                </button>
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  )
}
