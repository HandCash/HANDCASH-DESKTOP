import type { CSSProperties } from 'react'
import { bapFingerprint } from '../wallet/issuerTrust'
import type { IssuerViewState } from './IssuerIdentityMark'

/** 5×5 mirrored identicon drawn from the BAP ID's hash; vector, so nothing to defer. */
export function BapIdenticon({ bapId, size = 16 }: { bapId: string; size?: number }) {
  const { hue, cells } = bapFingerprint(bapId)
  return (
    <svg
      className="bap-identicon"
      data-aeon-part="bap-identicon"
      viewBox="0 0 5 5"
      width={size}
      height={size}
      aria-hidden
      focusable="false"
      shapeRendering="crispEdges"
      style={{ '--bap-hue': hue } as CSSProperties}
    >
      <rect width="5" height="5" fill="currentColor" opacity="0.14" />
      {cells.map((on, i) =>
        on ? <rect key={i} x={i % 5} y={Math.floor(i / 5)} width="1" height="1" fill="currentColor" /> : null,
      )}
    </svg>
  )
}

/** Identicon plus the short BAP ID, as an identity pill: the part a look-alike cannot copy. */
export function BapFingerprint({
  bapId,
  className,
  showId = true,
  state,
}: {
  bapId: string
  className?: string
  /** Off where the surrounding label already spells the short BAP ID. */
  showId?: boolean
  /** The issuer trust state, so the pill tints like the identity it fingerprints. */
  state?: IssuerViewState
}) {
  return (
    <span
      className={className ? `identity-pill ${className}` : 'identity-pill'}
      data-aeon-part="bap-fingerprint"
      data-aeon-state={state}
      title={`BAP ID ${bapId}`}
    >
      <span className="identity-pill-lead">
        <BapIdenticon bapId={bapId} size={10} />
      </span>
      {showId ? <span className="identity-pill-id mono">{bapFingerprint(bapId).short}</span> : null}
    </span>
  )
}
