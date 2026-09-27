import { DeferredImage } from './DeferredImage'
import { CollectablesIcon } from './icons'

type Props = {
  tokenId: string
  sym: string
  iconUrl?: string
  size: number
  className?: string
  /** `circle` for the token strip; default keeps the square face. */
  shape?: 'square' | 'circle'
}

function TokenPlaceholder({ size }: { size: number }) {
  const iconSize = size >= 120 ? 36 : size <= 56 ? 22 : 28
  return (
    <span className="collectable-media-fallback" aria-hidden>
      <CollectablesIcon size={iconSize} />
    </span>
  )
}

/**
 * Token face: real icon when we have one, otherwise the same collectables
 * placeholder. No generated identicon scheme.
 * Avatar.Root swallows non-Avatar.Image children — use a plain span so
 * local data: URLs from BEEF actually paint.
 */
export function FungibleTokenFace({
  tokenId: _tokenId,
  sym,
  iconUrl,
  size,
  className,
  shape = 'square',
}: Props) {
  const circle = shape === 'circle'
  const radius = circle ? size / 2 : size >= 120 ? 12 : size <= 56 ? 6 : 10
  const cls = ['fungible-avatar', className].filter(Boolean).join(' ')
  const local = Boolean(iconUrl && (iconUrl.startsWith('data:') || iconUrl.startsWith('blob:')))
  const faceStyle = {
    ['--fungible-face' as string]: `${size}px`,
    ['--fungible-face-radius' as string]: `${radius}px`,
  }

  return (
    <span
      className={cls}
      data-aeon-state={iconUrl ? 'icon' : 'placeholder'}
      data-shape={shape}
      style={faceStyle}
    >
      {iconUrl && local ? (
        <img
          className="fungible-avatar-image"
          src={iconUrl}
          alt={sym}
          width={size}
          height={size}
        />
      ) : iconUrl ? (
        <DeferredImage
          className="fungible-avatar-image"
          src={iconUrl}
          alt={sym}
          width={size}
          height={size}
          skeletonWidth={size}
          skeletonHeight={size}
          skeletonRadius={radius}
          retainDecoded
          fallback={<TokenPlaceholder size={size} />}
        />
      ) : (
        <TokenPlaceholder size={size} />
      )}
    </span>
  )
}
