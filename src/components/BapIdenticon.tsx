import type { CSSProperties } from 'react'
import { bapFingerprint } from '../wallet/issuerTrust'

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

/** Identicon plus the short BAP ID: the part of an identity a look-alike cannot copy. */
export function BapFingerprint({
  bapId,
  className,
  showId = true,
}: {
  bapId: string
  className?: string
  /** Off where the surrounding label already spells the short BAP ID. */
  showId?: boolean
}) {
  return (
    <span
      className={className ? `bap-fingerprint ${className}` : 'bap-fingerprint'}
      data-aeon-part="bap-fingerprint"
      title={`BAP ID ${bapId}`}
    >
      <BapIdenticon bapId={bapId} />
      {showId ? <span className="bap-fingerprint-id mono">{bapFingerprint(bapId).short}</span> : null}
    </span>
  )
}
