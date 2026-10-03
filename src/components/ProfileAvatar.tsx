import { useMemo, useSyncExternalStore } from 'react'
import { issuerIdentitiesGeneration, subscribeIssuerIdentities } from '../wallet/issuerIdentities'
import { issuerIdentityImageDataUrl } from '../wallet/issuerIdentity'
import {
  accountProfile,
  publicIdentitiesGeneration,
  subscribePublicIdentities,
  type AccountProfile,
} from '../wallet/publicIdentities'
import { getWalletRuntime } from '../wallet/walletRuntime'
import { BapIdenticon } from './BapIdenticon'
import { DeferredImage } from './DeferredImage'

/** Profile picture, else its identicon, else the label's initial. */
export function ProfileAvatar({ profile, label }: { profile: AccountProfile | null; label: string }) {
  const image = profile?.image
  const src = useMemo(() => (image ? issuerIdentityImageDataUrl(image) : null), [image])
  const identicon = profile ? <BapIdenticon bapId={profile.bapId} size={32} /> : null
  return (
    <span
      data-aeon-part="avatar"
      data-aeon-state={src ? 'image' : profile ? 'identicon' : 'initial'}
      aria-hidden
    >
      {src ? (
        <DeferredImage
          src={src}
          alt=""
          skeletonWidth="100%"
          skeletonHeight="100%"
          skeletonRadius="50%"
          fallback={identicon}
        />
      ) : (
        (identicon ?? label.trim().slice(0, 1).toUpperCase())
      )}
    </span>
  )
}

let cached: { key: string; profile: AccountProfile | null } | null = null

/** The public profile the unlocked account presents; one read per identity change, shared by every row. */
export function useCurrentAccountProfile(): AccountProfile | null {
  const generation = useSyncExternalStore(subscribePublicIdentities, publicIdentitiesGeneration)
  const packages = useSyncExternalStore(subscribeIssuerIdentities, issuerIdentitiesGeneration)
  const active = getWalletRuntime()?.instance
  if (!active) return null
  const key = `${active.chain}:${active.identityKey}:${active.accountIndex}:${generation}:${packages}`
  if (cached?.key !== key) {
    cached = {
      key,
      profile: accountProfile({
        identityKey: active.identityKey,
        accountIndex: active.accountIndex,
        chain: active.chain,
      }),
    }
  }
  return cached.profile
}
