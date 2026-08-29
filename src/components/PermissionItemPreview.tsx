import { useEffect, useState } from 'react'
import { getCachedCollectables } from '../wallet/collectables'
import { getCachedFungibles } from '../wallet/fungibles'
import { getTokenIconDataUrl } from '../wallet/tokenIconCache'
import { DeferredImage } from './DeferredImage'
import { CollectablesIcon, TokensIcon } from './icons'

type Preview = {
  name: string
  imageUrl?: string
  kind: 'token' | 'collectable'
  subtitle: string
}

function norm(raw: string): string {
  return raw.replace('_', '.').toLowerCase()
}

function resolvePreview(outpoint?: string, tokenId?: string): Preview | null {
  const tip = outpoint ? norm(outpoint) : ''
  const id = tokenId ? norm(tokenId) : ''
  if (tip) {
    const item = getCachedCollectables().find(
      (candidate) => norm(candidate.outpoint) === tip,
    )
    if (item) {
      return {
        name: item.name,
        imageUrl: item.imageUrl,
        kind: 'collectable',
        subtitle: item.proven ? 'Origin verified' : 'Collectable',
      }
    }
  }
  const tokens = getCachedFungibles()
  const token = tokens.find((row) => {
    const rowOp = norm(row.outpoint)
    const rowId = norm(row.tokenId)
    return (tip && (rowOp === tip || rowId === tip)) || (id && rowId === id)
  })
  if (token) {
    return {
      name: token.sym || 'Token',
      imageUrl: token.iconUrl || getTokenIconDataUrl(token.icon),
      kind: 'token',
      subtitle: 'Token',
    }
  }
  return null
}

export function PermissionItemPreview({
  outpoint,
  tokenId,
}: {
  outpoint?: string
  tokenId?: string
}) {
  const [item, setItem] = useState<Preview | null>(null)

  useEffect(() => {
    setItem(resolvePreview(outpoint, tokenId))
  }, [outpoint, tokenId])

  if (!item) return null
  const Fallback = item.kind === 'token' ? TokensIcon : CollectablesIcon

  return (
    <div className="permission-item-preview" data-aeon-part="item-preview">
      <DeferredImage
        src={item.imageUrl}
        alt={item.name}
        width={56}
        height={56}
        skeletonWidth={56}
        skeletonHeight={56}
        skeletonRadius={8}
        decoding="async"
        retainDecoded
        fallback={
          <span className="permission-item-preview-fallback" aria-hidden>
            <Fallback size={22} />
          </span>
        }
      />
      <div className="permission-item-preview-copy">
        <span>{item.subtitle}</span>
        <strong title={item.name}>{item.name}</strong>
      </div>
    </div>
  )
}
