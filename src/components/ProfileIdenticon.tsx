import { profileFingerprint } from '../wallet/issuerTrust'
import type { IssuerViewState } from './IssuerIdentityMark'

/**
 * 5×5 mirrored identicon drawn from the profile ID's hash (an identity key or
 * a BAP ID); vector, so nothing to defer. Colours come from the ID alone — an
 * opaque plate, never `currentColor` or a see-through fill — so the
 * fingerprint reads the same in every theme.
 */
export function ProfileIdenticon({ id, size = 16 }: { id: string; size?: number }) {
  const { hue, cells } = profileFingerprint(id)
  const plate = `hsl(${hue} 48% 91%)`
  const ink = `hsl(${hue} 62% 40%)`
  return (
    <svg
      className="profile-identicon"
      data-aeon-part="profile-identicon"
      viewBox="0 0 5 5"
      width={size}
      height={size}
      aria-hidden
      focusable="false"
      shapeRendering="crispEdges"
    >
      <rect width="5" height="5" fill={plate} />
      {cells.map((on, i) =>
        on ? <rect key={i} x={i % 5} y={Math.floor(i / 5)} width="1" height="1" fill={ink} /> : null,
      )}
    </svg>
  )
}

/** Identicon plus the short profile ID, as an identity pill: the part a look-alike cannot copy. */
export function ProfileFingerprint({
  id,
  className,
  showId = true,
  state,
}: {
  id: string
  className?: string
  /** Off where the surrounding label already spells the short profile ID. */
  showId?: boolean
  /** The issuer trust state, so the pill tints like the identity it fingerprints. */
  state?: IssuerViewState
}) {
  return (
    <span
      className={className ? `identity-pill ${className}` : 'identity-pill'}
      data-aeon-part="profile-fingerprint"
      data-aeon-state={state}
      title={`Profile ID ${id}`}
    >
      <span className="identity-pill-lead">
        <ProfileIdenticon id={id} size={10} />
      </span>
      {showId ? <span className="identity-pill-id mono">{profileFingerprint(id).short}</span> : null}
    </span>
  )
}

/**
 * The same pill for a Sigma signer address the 1Sat index reports. A claim,
 * never verified here, so it always tints as one.
 */
export function SignerFingerprint({ address, className }: { address: string; className?: string }) {
  return (
    <span
      className={className ? `identity-pill ${className}` : 'identity-pill'}
      data-aeon-part="signer-fingerprint"
      data-aeon-state="claim"
      title={`Signed by ${address} · as the index reports it, not checked here`}
    >
      <span className="identity-pill-lead">
        <ProfileIdenticon id={address} size={10} />
      </span>
      <span className="identity-pill-id mono">{profileFingerprint(address).short}</span>
    </span>
  )
}
