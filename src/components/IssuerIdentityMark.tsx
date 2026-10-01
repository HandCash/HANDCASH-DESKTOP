import { useMemo } from 'react'
import type { IssuerView } from '../wallet/collectableGroups'
import { issuerIdentityImageDataUrl } from '../wallet/issuerIdentity'
import { DeferredImage } from './DeferredImage'

export function issuerViewState(view: IssuerView): 'verified' | 'unconfirmed' | 'key' | 'claim' {
  return view.bap?.state ?? (view.issuerAttested ? 'key' : 'claim')
}

export function issuerViewTitle(view: IssuerView): string {
  if (view.bap?.state === 'verified') return `${view.label} · BAP ID ${view.bap.id}`
  if (view.bap) return `BAP ID ${view.bap.id} · no identity package on this device confirms this signer`
  return view.issuerAttested
    ? `Signed by ${view.identityKey}`
    : `Unsigned issuer claim ${view.identityKey}`
}

/** Issuer name beside the identity's image; only a verified signer has one. */
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
    </span>
  )
}
