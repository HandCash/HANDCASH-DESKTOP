import { useEffect, useState } from 'react'
import { getCachedCollectables, type Collectable } from '../wallet/collectables'
import { DeferredImage } from './DeferredImage'
import { CollectablesIcon } from './icons'

/**
 * Show the tip an app wants to sell, resolved from the wallet's own basket.
 *
 * The app supplies an outpoint and nothing else, so the name and picture on the
 * prompt are the ones the wallet already holds for that tip — an app cannot
 * label a cheap item with an expensive one's art to get a signature.
 */
export function PermissionItemPreview({ outpoint }: { outpoint: string }) {
  const [item, setItem] = useState<Collectable | null>(null)
  const [resolved, setResolved] = useState(false)

  useEffect(() => {
    const target = outpoint.replace('_', '.').toLowerCase()
    const match = getCachedCollectables().find(
      (candidate) => candidate.outpoint.replace('_', '.').toLowerCase() === target,
    )
    setItem(match ?? null)
    setResolved(true)
  }, [outpoint])

  // Never assert anything about an item the wallet cannot vouch for.
  if (!resolved || !item) return null

  return (
    <div className="permission-item-preview" data-aeon-part="item-preview">
      <DeferredImage
        src={item.imageUrl}
        alt={item.name}
        width={96}
        height={96}
        skeletonWidth={96}
        skeletonHeight={96}
        skeletonRadius={10}
        decoding="async"
        retainDecoded
        fallback={
          <span className="permission-item-preview-fallback" aria-hidden>
            <CollectablesIcon size={30} />
          </span>
        }
      />
      <div className="permission-item-preview-copy">
        <span>{item.proven ? 'Origin verified' : 'Item'}</span>
        <strong title={item.name}>{item.name}</strong>
        <code title={item.origin}>{item.origin}</code>
      </div>
    </div>
  )
}
