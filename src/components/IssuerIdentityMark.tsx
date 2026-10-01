import { useMemo } from 'react'
import type { IssuerBap, IssuerView } from '../wallet/collectableGroups'
import { issuerIdentityImageDataUrl } from '../wallet/issuerIdentity'
import { BapFingerprint } from './BapIdenticon'
import { DeferredImage } from './DeferredImage'
import { VerifiedIcon, WarningIcon } from './icons'

export type IssuerViewState =
  | 'listed'
  | 'imitation'
  | 'shared-name'
  | 'verified'
  | 'unconfirmed'
  | 'key'
  | 'claim'

type IssuerTrustSubject = { bap?: IssuerBap; issuerAttested?: boolean }

export function issuerViewState(view: IssuerTrustSubject): IssuerViewState {
  const bap = view.bap
  if (bap?.state === 'verified') {
    if (bap.listed) return 'listed'
    if (bap.caution?.kind === 'imitates-listed') return 'imitation'
    if (bap.caution?.kind === 'shared-name') return 'shared-name'
    return 'verified'
  }
  return bap?.state ?? (view.issuerAttested ? 'key' : 'claim')
}

/** One sentence on how far this issuer can be trusted; null when there is no BAP identity. */
export function issuerTrustNote(view: Pick<IssuerView, 'bap' | 'label'>): string | null {
  const bap = view.bap
  if (!bap) return null
  if (bap.state === 'unconfirmed')
    return 'No identity package on this device proves this signer speaks for the BAP ID, so its name and image stay hidden.'
  if (bap.listed)
    return bap.listed.name === view.label
      ? 'Verified by HandCash.'
      : `Verified by HandCash as “${bap.listed.name}”.`
  if (bap.caution?.kind === 'imitates-listed')
    return `Not verified. Its name reads like “${bap.caution.listed.name}”, which HandCash verified under a different BAP ID.`
  if (bap.caution?.kind === 'shared-name')
    return `Not verified. ${bap.caution.others === 1 ? 'Another identity' : `${bap.caution.others} other identities`} on this device use the same name; compare the BAP ID.`
  return 'Its identity package proves the signer. Not on HandCash’s verified list; compare the BAP ID.'
}

export function issuerViewTitle(view: IssuerView): string {
  if (view.bap) {
    const head = view.bap.state === 'verified' ? `${view.label} · BAP ID ${view.bap.id}` : `BAP ID ${view.bap.id}`
    return `${head} · ${issuerTrustNote(view)}`
  }
  return view.issuerAttested
    ? `Signed by ${view.identityKey}`
    : `Unsigned issuer claim ${view.identityKey}`
}

/** The checkmark or caution that sits after an issuer name. */
export function IssuerTrustBadge({ view }: { view: IssuerTrustSubject }) {
  const state = issuerViewState(view)
  if (state === 'listed')
    return (
      <span className="issuer-trust-badge" data-aeon-part="issuer-trust" data-aeon-state={state} role="img" aria-label="Verified by HandCash">
        <VerifiedIcon size={15} />
      </span>
    )
  if (state === 'imitation' || state === 'shared-name')
    return (
      <span
        className="issuer-trust-badge"
        data-aeon-part="issuer-trust"
        data-aeon-state={state}
        role="img"
        aria-label={state === 'imitation' ? 'Looks like a verified issuer' : 'Name shared with another identity'}
      >
        <WarningIcon size={15} />
      </span>
    )
  return null
}

/** Issuer name beside the identity's image, its HandCash checkmark and its BAP fingerprint. */
export function IssuerIdentityMark({ view, className }: { view: IssuerView; className: string }) {
  const image = view.bap?.identity?.image
  const src = useMemo(() => (image ? issuerIdentityImageDataUrl(image) : null), [image])
  return (
    <span
      className={`issuer-identity-mark ${className}`}
      data-aeon-part="issuer"
      data-aeon-state={issuerViewState(view)}
      title={issuerViewTitle(view)}
    >
      {src ? (
        <DeferredImage
          className="issuer-identity-mark-icon"
          src={src}
          alt=""
          width={18}
          height={18}
          skeletonWidth={18}
          skeletonHeight={18}
          skeletonRadius={5}
        />
      ) : null}
      <span className="issuer-identity-mark-label">{view.label}</span>
      <IssuerTrustBadge view={view} />
      {view.bap ? (
        <BapFingerprint
          bapId={view.bap.id}
          className="issuer-identity-mark-fingerprint"
          showId={view.bap.state === 'verified'}
        />
      ) : null}
    </span>
  )
}
