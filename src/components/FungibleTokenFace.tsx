import { useState } from 'react'
import { identiconDataUrl } from '@aeon-ui/core'
import { Avatar } from '@aeon-ui/ui'

type Props = {
  tokenId: string
  sym: string
  iconUrl?: string
  size: number
  className?: string
}

/**
 * Token face: hash identicon immediately; optional on-chain icon overlays when it
 * actually loads (ordinal content URLs often stall — never leave an empty loader).
 */
export function FungibleTokenFace({ tokenId, sym, iconUrl, size, className }: Props) {
  const [remoteReady, setRemoteReady] = useState(false)
  const seed = tokenId.trim() || sym.trim() || 'token'
  const sizeClass =
    size >= 120 ? 'fungible-avatar--lg' : size <= 56 ? 'fungible-avatar--sm' : ''

  return (
    <Avatar.Root
      size={size >= 120 ? 'xl' : 'md'}
      className={['fungible-avatar', sizeClass, className].filter(Boolean).join(' ')}
      data-aeon-state={iconUrl && !remoteReady ? 'loading' : 'ready'}
    >
      {iconUrl ? (
        <Avatar.Image
          src={iconUrl}
          alt={sym}
          decoding="async"
          onLoad={() => setRemoteReady(true)}
          onError={() => setRemoteReady(false)}
        />
      ) : null}
      <Avatar.Fallback aria-hidden>
        <img src={identiconDataUrl(seed, size)} alt="" draggable={false} />
      </Avatar.Fallback>
    </Avatar.Root>
  )
}
