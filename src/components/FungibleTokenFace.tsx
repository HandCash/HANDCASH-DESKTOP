import { identiconDataUrl } from '@aeon-ui/core'
import { Avatar } from '@aeon-ui/ui'
import { DeferredImage } from './DeferredImage'

type Props = {
  tokenId: string
  sym: string
  iconUrl?: string
  size: number
  className?: string
}

/**
 * Token face: defer every bitmap and reveal the deterministic identicon only
 * after the optional token icon fails. No image-dependent UI paints early.
 */
export function FungibleTokenFace({ tokenId, sym, iconUrl, size, className }: Props) {
  const seed = tokenId.trim() || sym.trim() || 'token'
  const identicon = identiconDataUrl(seed, size)
  const sizeClass =
    size >= 120
      ? 'fungible-avatar--lg'
      : size <= 56
        ? 'fungible-avatar--sm'
        : 'fungible-avatar--md'

  return (
    <Avatar.Root
      size={size >= 120 ? 'xl' : 'md'}
      className={['fungible-avatar', sizeClass, className].filter(Boolean).join(' ')}
      data-aeon-state={iconUrl ? 'icon' : 'identicon'}
    >
      <DeferredImage
        className="fungible-avatar-image"
        src={iconUrl ?? identicon}
        alt={sym}
        width={size}
        height={size}
        skeletonWidth={size}
        skeletonHeight={size}
        skeletonRadius={size >= 120 ? 12 : 6}
        retainDecoded
        fallback={
          iconUrl ? (
            <DeferredImage
              className="fungible-avatar-image"
              src={identicon}
              alt={sym}
              width={size}
              height={size}
              skeletonWidth={size}
              skeletonHeight={size}
              skeletonRadius={size >= 120 ? 12 : 6}
              retainDecoded
            />
          ) : null
        }
      />
    </Avatar.Root>
  )
}
