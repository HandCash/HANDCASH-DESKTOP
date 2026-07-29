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
      data-aeon-scope="inventory"
      data-aeon-state={view}
    >
      <div className="connected-panel-head">
        <h2>Inventory</h2>
        <CollectionViewToggle label="Inventory view" />
      </div>
      {view === 'grid' ? (
        <div className="collection-grid collection-grid-empty">
          <p className="connected-empty-line">No items yet</p>
        </div>
      ) : (
        <p className="connected-empty-line">No items yet</p>
      )}
    </div>
  )
}
