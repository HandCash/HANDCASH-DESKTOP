import { useEffect, useState } from 'react'
import {
  getCollectionView,
  setCollectionView,
  subscribeCollectionView,
  type CollectionView,
  type CollectionViewScope,
} from '../wallet/collectionView'
import { ViewGridIcon, ViewListIcon } from './icons'

type Props = {
  label?: string
  scope?: CollectionViewScope
}

export function CollectionViewToggle({
  label = 'View',
  scope = 'apps',
}: Props) {
  const [view, setView] = useState<CollectionView>(() => getCollectionView(scope))

  useEffect(() => subscribeCollectionView(setView, scope), [scope])

  return (
    <div className="collection-view-toggle" role="group" aria-label={label}>
      <button
        type="button"
        className="collection-view-btn"
        aria-label="List view"
        aria-pressed={view === 'list'}
        title="List"
        data-active={view === 'list' ? true : undefined}
        onClick={() => setCollectionView('list', scope)}
      >
        <ViewListIcon size={16} />
      </button>
      <button
        type="button"
        className="collection-view-btn"
        aria-label="Grid view"
        aria-pressed={view === 'grid'}
        title="Grid"
        data-active={view === 'grid' ? true : undefined}
        onClick={() => setCollectionView('grid', scope)}
      >
        <ViewGridIcon size={16} />
      </button>
    </div>
  )
}
