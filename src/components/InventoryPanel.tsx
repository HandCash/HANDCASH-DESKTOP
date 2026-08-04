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
import { openCollectableDetails, openSendCollectable } from '../wallet/navStore'
import { refreshFromChain } from '../wallet/chainIngest'
import { subscribeSyncHealth } from '../wallet/walletHealth'
import { playWalletSound } from '../wallet/soundService'
import { EmptyState } from './EmptyState'
import { CollectablesIcon, SendIcon } from './icons'

function CollectableGridItem({ item }: { item: Collectable }) {
  return (
    <li className="collection-grid-card collectable-card">
      <button
        type="button"
        className="collection-grid-main collectable-main"
        onClick={() => {
          playWalletSound('soft')
          openCollectableDetails(item.outpoint)
        }}
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
      <button
        type="button"
        className="collectable-send-btn"
        title={`Send ${item.name}`}
        aria-label={`Send ${item.name}`}
        onClick={(e) => {
          e.stopPropagation()
          playWalletSound('soft')
          openSendCollectable(item.outpoint)
        }}
      >
        <SendIcon size={14} />
        Send
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
        onClick={() => {
          playWalletSound('soft')
          openCollectableDetails(item.outpoint)
        }}
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
      <button
        type="button"
        className="collectable-send-btn collectable-send-btn--row"
        title={`Send ${item.name}`}
        aria-label={`Send ${item.name}`}
        onClick={() => {
          playWalletSound('soft')
          openSendCollectable(item.outpoint)
        }}
      >
        <SendIcon size={14} />
        Send
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
  const [heldNote, setHeldNote] = useState<string | null>(null)

  useEffect(() => subscribeCollectionView(setView, 'collectables'), [])
  useEffect(
    () =>
      subscribeSyncHealth((h) => {
        setHeldNote(
          h.heldOneSats > 0
            ? `${h.heldOneSats} one-sat output${h.heldOneSats === 1 ? '' : 's'} waiting on the index.`
            : null,
        )
      }),
    [],
  )
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
        await refreshFromChain({ announceReceive: false, forceReview: showSpinner })
        await listCollectables()
        if (!cancelled) {
          setReady(areCollectablesHydrated())
          setAwaitingFirst(false)
        }
      } catch (err) {
        console.warn('[collectables] refresh failed', err)
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

  const showLoading = awaitingFirst || !ready

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

      {heldNote ? (
        <p className="wallet-sync-note" role="status">
          {heldNote}
        </p>
      ) : null}

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
      ) : showLoading ? (
        <EmptyState
          icon={<CollectablesIcon size={28} />}
          title="Looking for collectables…"
          body="Checking this device for one-sat items."
        />
      ) : (
        <EmptyState
          icon={<CollectablesIcon size={28} />}
          title="No collectables here"
          body="Items live on the install that received them. Refresh updates from the network; send to move them."
        />
      )}
    </div>
  )
}
