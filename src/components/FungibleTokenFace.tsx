import { noteArtRatio } from './artRatio'
import { DeferredImage } from './DeferredImage'
import { CollectablesIcon, LitecoinIcon } from './icons'

type Props = {
  tokenId: string
  sym: string
  iconUrl?: string
  size: number
  className?: string
  /** The chain a backed token's value sits on, from its deploy (`bk`); issuer metadata never sets it. */
  chainMark?: 'ltc'
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
 * placeholder. No generated identicon scheme. The icon is shown whole in a
 * rounded square, never cropped and never a circle.
 * Avatar.Root swallows non-Avatar.Image children — use a plain span so
 * local data: URLs from BEEF actually paint.
 */
export function FungibleTokenFace({
  tokenId: _tokenId,
  sym,
  iconUrl,
  size,
  className,
  chainMark,
}: Props) {
  const cls = ['fungible-avatar', className].filter(Boolean).join(' ')
  const local = Boolean(iconUrl && (iconUrl.startsWith('data:') || iconUrl.startsWith('blob:')))
  const radius = size >= 120 ? 12 : size <= 56 ? 6 : 10
  const faceStyle = {
    ['--fungible-face' as string]: `${size}px`,
    ['--art-radius' as string]: `${radius}px`,
  }

  return (
    <span
      className={cls}
      data-aeon-state={iconUrl ? 'icon' : 'placeholder'}
      style={faceStyle}
    >
      {iconUrl && local ? (
        <img
          className="fungible-avatar-image"
          src={iconUrl}
          alt={sym}
          width={size}
          height={size}
          onLoad={(event) => noteArtRatio(event.currentTarget)}
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
      ) : chainMark === 'ltc' ? (
        <span className="collectable-media-fallback" data-aeon-part="chain-face" aria-hidden>
          <LitecoinIcon size={Math.round(size * 0.72)} />
        </span>
      ) : (
        <TokenPlaceholder size={size} />
      )}
      {chainMark === 'ltc' && iconUrl ? (
        <span data-aeon-part="chain-mark" data-aeon-state="ltc" title="Backed by Litecoin">
          <LitecoinIcon size={Math.max(14, Math.round(size * 0.3))} />
        </span>
      ) : null}
    </span>
  )
}
