import { useMemo } from 'react'
import type { IssuerProfileMark, IssuerView } from '../wallet/collectableGroups'
import { issuerIdentityImageDataUrl } from '../wallet/issuerIdentity'
import { profileFingerprint } from '../wallet/issuerTrust'
import { ProfileIdenticon } from './ProfileIdenticon'
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

type IssuerTrustSubject = { profile?: IssuerProfileMark; issuerAttested?: boolean }

export function issuerViewState(view: IssuerTrustSubject): IssuerViewState {
  const mark = view.profile
  if (mark?.state === 'verified') {
    if (mark.listed) return 'listed'
    if (mark.caution?.kind === 'imitates-listed') return 'imitation'
    if (mark.caution?.kind === 'shared-name') return 'shared-name'
    return 'verified'
  }
  return mark?.state ?? (view.issuerAttested ? 'key' : 'claim')
}

/** One sentence on how far this issuer can be trusted; null when no profile labels it. */
export function issuerTrustNote(view: Pick<IssuerView, 'profile' | 'label'>): string | null {
  const mark = view.profile
  if (!mark) return null
  if (mark.state === 'unconfirmed')
    return 'No identity package on this device proves this signer speaks for the profile ID, so its name and image stay hidden.'
  if (mark.listed)
    return mark.listed.name === view.label
      ? 'Verified by HandCash.'
      : `Verified by HandCash as “${mark.listed.name}”.`
  if (mark.caution?.kind === 'imitates-listed')
    return `Not verified. Its name reads like “${mark.caution.listed.name}”, which HandCash verified under a different profile ID.`
  if (mark.caution?.kind === 'shared-name')
    return `Not verified. ${mark.caution.others === 1 ? 'Another identity' : `${mark.caution.others} other identities`} on this device use the same name; compare the profile ID.`
  return mark.profile?.source === 'identity-key'
    ? 'Signed by its own identity key. Not on HandCash’s verified list; compare the profile ID.'
    : 'Its identity package proves the signer. Not on HandCash’s verified list; compare the profile ID.'
}

export function issuerViewTitle(view: IssuerView): string {
  if (view.profile) {
    const head =
      view.profile.state === 'verified' ? `${view.label} · Profile ID ${view.profile.id}` : `Profile ID ${view.profile.id}`
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

/**
 * The identity pill: the profile's image (or identicon), its name, the
 * HandCash checkmark and the short profile ID — the part a look-alike cannot copy.
 */
export function IssuerIdentityMark({ view, className }: { view: IssuerView; className?: string }) {
  const image = view.profile?.profile?.image
  const src = useMemo(() => (image ? issuerIdentityImageDataUrl(image) : null), [image])
  const id = view.profile?.id
  return (
    <span
      className={className ? `identity-pill ${className}` : 'identity-pill'}
      data-aeon-part="issuer"
      data-aeon-state={issuerViewState(view)}
      title={issuerViewTitle(view)}
    >
      {src ? (
        <span className="identity-pill-lead">
          <DeferredImage
            className="identity-pill-image"
            src={src}
            alt=""
            width={16}
            height={16}
            skeletonWidth={16}
            skeletonHeight={16}
            skeletonRadius="50%"
            fallback={id ? <ProfileIdenticon id={id} size={10} /> : null}
          />
        </span>
      ) : id ? (
        <span className="identity-pill-lead">
          <ProfileIdenticon id={id} size={10} />
        </span>
      ) : null}
      <span className="identity-pill-label">{view.label}</span>
      <IssuerTrustBadge view={view} />
      {id && view.profile?.state === 'verified' ? (
        <span className="identity-pill-id mono">{profileFingerprint(id).short}</span>
      ) : null}
    </span>
  )
}
