import { useEffect, useState } from 'react'
import {
  getCollectionView,
  setCollectionView,
  subscribeCollectionView,
  type CollectionView,
} from '../wallet/collectionView'
import { ViewGridIcon, ViewListIcon } from './icons'

type Props = {
  label?: string
}

export function CollectionViewToggle({ label = 'View' }: Props) {
  const [view, setView] = useState<CollectionView>(() => getCollectionView())

  useEffect(() => subscribeCollectionView(setView), [])

  return (
    <div className="collection-view-toggle" role="group" aria-label={label}>
      <button
        type="button"
        className="collection-view-btn"
        aria-label="List view"
        aria-pressed={view === 'list'}
        title="List"
        data-active={view === 'list' ? true : undefined}
        onClick={() => setCollectionView('list')}
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
        onClick={() => setCollectionView('grid')}
      >
        <ViewGridIcon size={16} />
      </button>
    </div>
  )
}
