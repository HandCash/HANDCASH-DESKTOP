import { DeferredImage } from './DeferredImage'
import { CollectablesIcon } from './icons'

/** Stacked art for a folded shelf. Faces defer like any other bitmap. */
export function CollectFacepile({
  faces,
  overflow,
}: {
  faces: ReadonlyArray<{ outpoint: string; imageUrl: string | null | undefined }>
  overflow: number
}) {
  return (
    <span className="collect-facepile" aria-hidden>
      {faces.map((face) => (
        <span key={face.outpoint} className="collect-facepile-face">
          <DeferredImage
            src={face.imageUrl ?? undefined}
            alt=""
            width={40}
            height={40}
            skeletonWidth={40}
            skeletonHeight={40}
            skeletonRadius={8}
            skeletonClassName="skeleton-qr"
            decoding="async"
            fallback={
              <span className="collectable-media-fallback" aria-hidden>
                <CollectablesIcon size={18} />
              </span>
            }
          />
        </span>
      ))}
      {overflow > 0 ? (
        <span className="collect-facepile-more">+{overflow.toLocaleString()}</span>
      ) : null}
    </span>
  )
}
