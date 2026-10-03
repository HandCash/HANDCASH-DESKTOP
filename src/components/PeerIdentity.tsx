import { useMemo } from 'react'
import type { PeerIdentityView } from '../hooks/usePeerIdentity'
import { issuerIdentityImageDataUrl } from '../wallet/issuerIdentity'
import { bapFingerprint } from '../wallet/issuerTrust'
import { BapIdenticon } from './BapIdenticon'
import { DeferredImage } from './DeferredImage'
import { issuerTrustNote, issuerViewState, IssuerTrustBadge } from './IssuerIdentityMark'

function initial(label: string): string {
  const t = label.trim()
  return t ? t.slice(0, 1).toUpperCase() : '?'
}

/** A contact's avatar: the presented identity's image once it decodes, otherwise their initial. */
export function PeerAvatar({
  label,
  peer,
  className = 'friend-avatar',
}: {
  label: string
  peer: PeerIdentityView | null
  className?: string
}) {
  const image = peer?.kind === 'presented' ? peer.identity.image : undefined
  const src = useMemo(() => (image ? issuerIdentityImageDataUrl(image) : null), [image])
  return (
    <span className={className} data-aeon-part="peer-avatar" data-aeon-state={src ? 'image' : 'initial'} aria-hidden>
      {src ? (
        <DeferredImage
          className="peer-avatar-image"
          src={src}
          alt=""
          skeletonWidth="100%"
          skeletonHeight="100%"
          skeletonRadius="50%"
          fallback={initial(label)}
        />
      ) : (
        initial(label)
      )}
    </span>
  )
}

function peerTitle(peer: PeerIdentityView): string {
  if (peer.kind === 'missing-package')
    return `Profile ID ${peer.bapId} · This contact presented an identity whose package is no longer on this device.`
  const note = issuerTrustNote({ bap: peer.bap, label: peer.identity.name })
  return `${peer.identity.name} · Profile ID ${peer.identity.bapId} · Presented and signed by this wallet key. ${note ?? ''}`.trim()
}

/** The identity a contact presented, as the same pill issuers use: identicon, name, checkmark or caution, short BAP ID. */
export function PeerIdentityLine({ peer }: { peer: PeerIdentityView | null }) {
  if (!peer) return null
  const state = peer.kind === 'presented' ? issuerViewState({ bap: peer.bap }) : 'missing-package'
  const bapId = peer.kind === 'presented' ? peer.identity.bapId : peer.bapId
  return (
    <span className="identity-pill" data-aeon-part="peer-identity" data-aeon-state={state} title={peerTitle(peer)}>
      <span className="identity-pill-lead">
        <BapIdenticon bapId={bapId} size={10} />
      </span>
      {peer.kind === 'presented' ? (
        <>
          <span className="identity-pill-label">{peer.identity.name}</span>
          <IssuerTrustBadge view={{ bap: peer.bap }} />
        </>
      ) : null}
      <span className="identity-pill-id mono">{bapFingerprint(bapId).short}</span>
    </span>
  )
}
