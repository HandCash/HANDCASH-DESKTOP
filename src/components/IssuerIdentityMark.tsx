import { useMemo } from 'react'
import type { IssuerBap, IssuerView } from '../wallet/collectableGroups'
import { issuerIdentityImageDataUrl } from '../wallet/issuerIdentity'
import { bapFingerprint } from '../wallet/issuerTrust'
import { BapIdenticon } from './BapIdenticon'
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

/**
 * The identity pill: the identity's image (or BAP identicon), its name, the
 * HandCash checkmark and the short BAP ID — the part a look-alike cannot copy.
 */
export function IssuerIdentityMark({ view, className }: { view: IssuerView; className?: string }) {
  const image = view.bap?.identity?.image
  const src = useMemo(() => (image ? issuerIdentityImageDataUrl(image) : null), [image])
  const bapId = view.bap?.id
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
            fallback={bapId ? <BapIdenticon bapId={bapId} size={10} /> : null}
          />
        </span>
      ) : bapId ? (
        <span className="identity-pill-lead">
          <BapIdenticon bapId={bapId} size={10} />
        </span>
      ) : null}
      <span className="identity-pill-label">{view.label}</span>
      <IssuerTrustBadge view={view} />
      {bapId && view.bap?.state === 'verified' ? (
        <span className="identity-pill-id mono">{bapFingerprint(bapId).short}</span>
      ) : null}
    </span>
  )
}
