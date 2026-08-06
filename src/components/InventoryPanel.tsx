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
import { playWalletSound } from '../wallet/soundService'
import { EmptyState } from './EmptyState'
import { CollectablesIcon, SendIcon } from './icons'

/** Paint a few cards per frame so opening Collect does not block the UI. */
const RENDER_CHUNK = 6

function useChunkedCount(total: number): number {
  const [shown, setShown] = useState(() => Math.min(RENDER_CHUNK, total))

  useEffect(() => {
    setShown(Math.min(RENDER_CHUNK, total))
    if (total <= RENDER_CHUNK) return

    let cancelled = false
    let next = RENDER_CHUNK
    let handle = 0

    const step = () => {
      if (cancelled) return
      next = Math.min(total, next + RENDER_CHUNK)
      setShown(next)
      if (next < total) handle = window.requestAnimationFrame(step)
    }

    handle = window.requestAnimationFrame(step)
    return () => {
      cancelled = true
      if (handle) window.cancelAnimationFrame(handle)
    }
  }, [total])

  return shown
}

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
            decoding="async"
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
            decoding="async"
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
    const cached = getCachedCollectables().length
    console.info(`[collectables] open cache=${cached} hydrated=${areCollectablesHydrated()}`)
  }, [])

  useEffect(() => {
    let cancelled = false

    const refresh = async (reason: string) => {
      const showSpinner = !areCollectablesHydrated() && getCachedCollectables().length === 0
      if (showSpinner && !cancelled) setAwaitingFirst(true)
      try {
        console.info(`[collectables] listOutputs start (${reason})`)
        const started = performance.now()
        await listCollectables()
        console.info(
          `[collectables] listOutputs done (${reason}) ${Math.round(performance.now() - started)}ms`,
        )
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

    // CRITICAL: paint from durable cache immediately, then reconcile against
    // live address UTXOs within a beat. Waiting 15s left spent tips on screen.
    // Network work is async — it must not block the first paint.
    const hasCache = getCachedCollectables().length > 0 || areCollectablesHydrated()
    let intervalId = 0
    let deferTimer = 0

    if (hasCache) {
      deferTimer = window.setTimeout(() => {
        if (cancelled) return
        void refresh('ownership')
        intervalId = window.setInterval(() => {
          void refresh('interval')
        }, 60_000)
      }, 750)
      return () => {
        cancelled = true
        window.clearTimeout(deferTimer)
        if (intervalId) window.clearInterval(intervalId)
      }
    }

    // Cold start only — nothing to show until the basket is read once.
    deferTimer = window.setTimeout(() => {
      if (!cancelled) void refresh('cold')
    }, 2_500)
    intervalId = window.setInterval(() => {
      void refresh('interval')
    }, 60_000)
    return () => {
      cancelled = true
      window.clearTimeout(deferTimer)
      window.clearInterval(intervalId)
    }
  }, [])

  const showLoading = awaitingFirst || !ready
  const shownCount = useChunkedCount(items.length)
  const visibleItems = items.slice(0, shownCount)

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
            {visibleItems.map((item) => (
              <CollectableGridItem key={item.outpoint} item={item} />
            ))}
          </ul>
        ) : (
          <ul className="connected-app-list">
            {visibleItems.map((item) => (
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
          body="Items live on the install that received them. This device updates from the network automatically; send to move them."
        />
      )}
    </div>
  )
}
