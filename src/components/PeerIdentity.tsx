import { useMemo, type ReactNode } from 'react'
import { usePeerIdentity, type PeerIdentityView } from '../hooks/usePeerIdentity'
import type { Friend } from '../wallet/friends'
import type { Chain } from '../wallet/vault'
import { issuerIdentityImageDataUrl } from '../wallet/issuerIdentity'
import { profileFingerprint } from '../wallet/issuerTrust'
import { ProfileIdenticon } from './ProfileIdenticon'
import { DeferredImage } from './DeferredImage'
import { issuerTrustNote, issuerViewState, IssuerTrustBadge } from './IssuerIdentityMark'

function initial(label: string): string {
  const t = label.trim()
  return t ? t.slice(0, 1).toUpperCase() : '?'
}

/** A contact's avatar: the presented profile's image once it decodes, otherwise their initial. */
export function PeerAvatar({
  label,
  peer,
  className = 'friend-avatar',
}: {
  label: string
  peer: PeerIdentityView | null
  className?: string
}) {
  const image = peer?.kind === 'presented' ? peer.profile.image : undefined
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
    return `Profile ID ${peer.id} · This contact presented a profile that is no longer on this device.`
  const note = issuerTrustNote({ profile: peer.mark, label: peer.profile.name })
  return `${peer.profile.name} · Profile ID ${peer.profile.id} · Presented and signed by this wallet key. ${note ?? ''}`.trim()
}

/** The profile a contact presented, as the same pill issuers use: identicon, name, checkmark or caution, short profile ID. */
export function PeerIdentityLine({ peer }: { peer: PeerIdentityView | null }) {
  if (!peer) return null
  const state = peer.kind === 'presented' ? issuerViewState({ profile: peer.mark }) : 'missing-package'
  const id = peer.kind === 'presented' ? peer.profile.id : peer.id
  return (
    <span className="identity-pill" data-aeon-part="peer-identity" data-aeon-state={state} title={peerTitle(peer)}>
      <span className="identity-pill-lead">
        <ProfileIdenticon id={id} size={10} />
      </span>
      {peer.kind === 'presented' ? (
        <>
          <span className="identity-pill-label">{peer.profile.name}</span>
          <IssuerTrustBadge view={{ profile: peer.mark }} />
        </>
      ) : null}
      <span className="identity-pill-id mono">{profileFingerprint(id).short}</span>
    </span>
  )
}

export type PeerIdentityBlockProps = {
  label: string
  peer: PeerIdentityView | null
  /** The contact's name as the screen titles it. */
  name: ReactNode
  /** Shown under the name when the contact presented no profile. */
  fallback: ReactNode
  avatarClassName?: string
  /** Wraps the name and identity line in a div (`''` for no class); without it they sit beside the avatar. */
  bodyClassName?: string
}

/** A contact's avatar, then their name over the profile they presented, else `fallback`. */
export function PeerIdentityBlock({ label, peer, name, fallback, avatarClassName, bodyClassName }: PeerIdentityBlockProps) {
  const lines = (
    <>
      {name}
      {peer ? <PeerIdentityLine peer={peer} /> : fallback}
    </>
  )
  return (
    <>
      <PeerAvatar label={label} peer={peer} className={avatarClassName} />
      {bodyClassName === undefined ? lines : <div className={bodyClassName || undefined}>{lines}</div>}
    </>
  )
}

/** {@link PeerIdentityBlock} for a saved friend; asks them again for a profile this device evicted. */
export function FriendIdentityBlock({
  chain,
  friend,
  ...block
}: Omit<PeerIdentityBlockProps, 'label' | 'peer'> & { chain: Chain; friend: Friend }) {
  const peer = usePeerIdentity(chain, friend.identityKey, friend)
  return <PeerIdentityBlock label={friend.label} peer={peer} {...block} />
}

/** A contact's avatar looked up by wallet key alone, for rows with no identity line. */
export function PeerAvatarForKey({
  chain,
  identityKey,
  label,
  className,
}: {
  chain: Chain
  identityKey?: string
  label: string
  className?: string
}) {
  const peer = usePeerIdentity(chain, identityKey)
  return <PeerAvatar label={label} peer={peer} className={className} />
}
