import { useEffect, useState } from 'react'
import { CollectionViewToggle } from './CollectionViewToggle'
import { DeferredImage } from './DeferredImage'
import {
  getCollectionView,
  subscribeCollectionView,
  type CollectionView,
} from '../wallet/collectionView'
import {
  areCollectablesHydrated,
  getCachedCollectables,
  listCollectables,
  subscribeCollectables,
  type Collectable,
} from '../wallet/collectables'
import { openCollectableDetails } from '../wallet/navStore'
import { syncLegacyFunds } from '../wallet/syncFunds'

function CollectableGridItem({ item }: { item: Collectable }) {
  return (
    <li className="collection-grid-card collectable-card">
      <button
        type="button"
        className="collection-grid-main collectable-main"
        onClick={() => openCollectableDetails(item.outpoint)}
      >
        <div className="collectable-media">
          <DeferredImage
            src={item.imageUrl}
            alt={item.name}
            width={120}
            height={120}
            skeletonWidth={120}
            skeletonHeight={120}
            skeletonRadius={8}
            skeletonClassName="skeleton-qr"
          />
        </div>
        <strong className="collection-grid-name" title={item.name}>
          {item.name}
        </strong>
        {item.app ? (
          <span className="collection-grid-host" title={item.app}>
            {item.app}
          </span>
        ) : null}
      </button>
    </li>
  )
}

function CollectableListItem({ item }: { item: Collectable }) {
  return (
    <li className="connected-app-row collectable-row">
      <button
        type="button"
        className="connected-app-main collectable-row-main"
        onClick={() => openCollectableDetails(item.outpoint)}
      >
        <div className="collectable-media collectable-media-sm">
          <DeferredImage
            src={item.imageUrl}
            alt={item.name}
            width={48}
            height={48}
            skeletonWidth={48}
            skeletonHeight={48}
            skeletonRadius={6}
            skeletonClassName="skeleton-qr"
          />
        </div>
        <div className="connected-app-body">
          <strong className="connected-app-name">{item.name}</strong>
          {item.app ? <span className="connected-app-host">{item.app}</span> : null}
        </div>
      </button>
    </li>
  )
}

export function InventoryPanel() {
  const [view, setView] = useState<CollectionView>(() => getCollectionView('collectables'))
  const [items, setItems] = useState<Collectable[]>(() => getCachedCollectables())
  /** Only true after a successful listOutputs (may be empty). */
  const [ready, setReady] = useState(() => areCollectablesHydrated())
  /** In-flight load while we still have nothing to show. */
  const [awaitingFirst, setAwaitingFirst] = useState(
    () => !areCollectablesHydrated() && getCachedCollectables().length === 0,
  )

  useEffect(() => subscribeCollectionView(setView, 'collectables'), [])
  useEffect(
    () =>
      subscribeCollectables((next) => {
        setItems(next)
        if (areCollectablesHydrated()) {
          setReady(true)
          setAwaitingFirst(false)
        }
      }),
    [],
  )

  useEffect(() => {
    let cancelled = false

    const refresh = async () => {
      const showSpinner = !areCollectablesHydrated() && getCachedCollectables().length === 0
      if (showSpinner && !cancelled) setAwaitingFirst(true)
      try {
        await syncLegacyFunds()
        await listCollectables()
        if (!cancelled) {
          setReady(areCollectablesHydrated())
          setAwaitingFirst(false)
        }
      } catch (err) {
        console.warn('[collectables] refresh failed', err)
        // Stay on loading copy until we have a real successful read — never flash empty.
        if (!cancelled && areCollectablesHydrated()) {
          setReady(true)
          setAwaitingFirst(false)
        }
      }
    }

    void refresh()
    const id = window.setInterval(() => {
      void refresh()
    }, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  return (
    <div
      className="nav-section-body"
      data-aeon-scope="collectables"
      data-aeon-state={view}
    >
      <div className="connected-panel-head">
        <h2>Collectables</h2>
        <CollectionViewToggle label="Collectables view" scope="collectables" />
      </div>

      {items.length > 0 ? (
        view === 'grid' ? (
          <ul className="collection-grid">
            {items.map((item) => (
              <CollectableGridItem key={item.outpoint} item={item} />
            ))}
          </ul>
        ) : (
          <ul className="connected-app-list">
            {items.map((item) => (
              <CollectableListItem key={item.outpoint} item={item} />
            ))}
          </ul>
        )
      ) : awaitingFirst || !ready ? (
        <p className="connected-empty-line">Looking for collectables…</p>
      ) : (
        <p className="connected-empty-line">No collectables yet</p>
      )}
    </div>
  )
}
