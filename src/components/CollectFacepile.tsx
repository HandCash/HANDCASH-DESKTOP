import { DeferredImage } from './DeferredImage'
import { CollectablesIcon } from './icons'

/**
 * Stacked art for a folded shelf: a compact overlapping deck, so the shelf's
 * name keeps the room. The count lives in the shelf's meta line, not here.
 * Faces defer like any other bitmap.
 */
export function CollectFacepile({
  faces,
}: {
  faces: ReadonlyArray<{ outpoint: string; imageUrl: string | null | undefined }>
}) {
  return (
    <span className="collect-facepile" aria-hidden>
      {faces.map((face) => (
        <span key={face.outpoint} className="collect-facepile-face">
          <DeferredImage
            src={face.imageUrl ?? undefined}
            alt=""
            width={36}
            height={36}
            skeletonWidth={36}
            skeletonHeight={36}
            skeletonRadius={8}
            skeletonClassName="skeleton-qr"
            decoding="async"
            fallback={
              <span className="collectable-media-fallback" aria-hidden>
                <CollectablesIcon size={16} />
              </span>
            }
          />
        </span>
      ))}
    </span>
  )
}
