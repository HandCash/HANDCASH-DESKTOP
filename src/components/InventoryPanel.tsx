import { useEffect, useState } from 'react'
import { CollectionViewToggle } from './CollectionViewToggle'
import {
  getCollectionView,
  subscribeCollectionView,
  type CollectionView,
} from '../wallet/collectionView'

export function InventoryPanel() {
  const [view, setView] = useState<CollectionView>(() => getCollectionView())

  useEffect(() => subscribeCollectionView(setView), [])

  return (
    <div
      className="nav-section-body"
      data-aeon-scope="collectables"
      data-aeon-state={view}
    >
      <div className="connected-panel-head">
        <h2>Collectables</h2>
        <CollectionViewToggle label="Collectables view" />
      </div>
      {view === 'grid' ? (
        <div className="collection-grid collection-grid-empty">
          <p className="connected-empty-line">No collectables yet</p>
        </div>
      ) : (
        <p className="connected-empty-line">No collectables yet</p>
      )}
    </div>
  )
}
