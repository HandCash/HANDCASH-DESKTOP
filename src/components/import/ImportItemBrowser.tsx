import { memo, useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { Accordion, Progress, StatusBanner } from '@aeon-ui/react'
import {
  importItemBrowserMachine,
  queuedOutpoints,
  selectedPerShelf,
  shelvedTotal,
  type ImportItemPorts,
} from '../../machines/importItemBrowserMachine'
import {
  dismissImportReport,
  enqueueImportItems,
  importShelfOutpoints,
  readImportItems,
  readImportShelves,
  stopImportItems,
  syncImportItems,
  watchImportSource,
  type ImportItem,
  type ImportItemShelf,
} from '../../wallet/import'
import { importItemGroup } from '../../wallet/import/importItem'
import { groupQuantityLabel } from '../../wallet/collectableGroups'
import {
  getCollectionView,
  subscribeCollectionView,
  type CollectionView,
} from '../../wallet/collectionView'
import { playWalletSound } from '../../wallet/soundService'
import { SignerFingerprint } from '../BapIdenticon'
import { CollectFacepile } from '../CollectFacepile'
import { CollectionViewToggle } from '../CollectionViewToggle'
import { DeferredImage } from '../DeferredImage'
import { SelectionCheckbox } from '../SelectionCheckbox'
import { Skeleton, SkeletonLine } from '../Skeleton'
import { useWalletActionDock } from '../WalletActionDock'
import { CloseIcon, CollectablesIcon, DownloadIcon } from '../icons'
import { useScrollIdle } from '../uiFeed/useScrollIdle'
import { useWindowedRange } from '../uiFeed/useWindowedRange'

const PORTS: ImportItemPorts = {
  sync: (sourceId, onChange, shouldStop) => syncImportItems({ sourceId, onChange, shouldStop }),
  readShelves: readImportShelves,
  readPage: (sourceId, opts) => readImportItems({ sourceId, ...opts }),
  shelfOutpoints: importShelfOutpoints,
  enqueue: enqueueImportItems,
  stop: stopImportItems,
  dismiss: dismissImportReport,
  watch: watchImportSource,
}

/** Collect's view preference — the browser is Collect's face. */
const subscribeView = (onChange: () => void) => subscribeCollectionView(() => onChange(), 'collectables')
const readView = () => getCollectionView('collectables')

const SKELETON_CARDS = 6

type ItemActions = {
  onImport: (outpoint: string) => void
  onSelect: (item: ImportItem, checked: boolean) => void
}

/** Where the background queue has this item: moving in the chunk in flight, or waiting. */
type QueueSpot = 'moving' | 'waiting' | null

type CardProps = ItemActions & {
  item: ImportItem
  selected: boolean
  spot: QueueSpot
  locked: boolean
}

function cardState(spot: QueueSpot, selected: boolean): string {
  return spot ?? (selected ? 'selected' : 'idle')
}

function importLabel(spot: QueueSpot): string {
  return spot === 'moving' ? 'Importing…' : spot === 'waiting' ? 'Queued' : 'Import'
}

function itemName(item: ImportItem): string {
  return item.name ?? 'Untitled'
}

function itemHost(item: ImportItem): string {
  return item.app ?? '\u00a0'
}

function ItemArt({ item, size }: { item: ImportItem; size: 120 | 48 }) {
  return (
    <DeferredImage
      src={item.imageUrl ?? undefined}
      alt={itemName(item)}
      width={size}
      height={size}
      skeletonWidth={size}
      skeletonHeight={size}
      skeletonRadius={size === 120 ? 8 : 6}
      skeletonClassName="skeleton-qr"
      decoding="async"
      fallback={
        <span className="collectable-media-fallback" aria-hidden>
          <CollectablesIcon size={size === 120 ? 36 : 22} />
        </span>
      }
    />
  )
}

/** Collect's grid card with Import in place of Send; the card itself selects. */
const ImportGridItem = memo(function ImportGridItem({ item, selected, spot, locked, onImport, onSelect }: CardProps) {
  const name = itemName(item)
  const action = `${importLabel(spot).replace('…', '')} ${name}`
  const busy = locked || spot != null
  return (
    <li
      className="collection-grid-card collectable-card"
      data-aeon-part="item"
      data-aeon-state={cardState(spot, selected)}
    >
      <button
        type="button"
        className="collection-grid-main collectable-main"
        aria-pressed={selected}
        disabled={busy}
        onClick={() => onSelect(item, !selected)}
      >
        <div className="collectable-media">
          <ItemArt item={item} size={120} />
        </div>
        <strong className="collection-grid-name" title={name}>
          {name}
        </strong>
        <span className="collection-grid-host" title={item.app ?? undefined} aria-hidden={item.app ? undefined : true}>
          {itemHost(item)}
        </span>
      </button>
      <div className="collectable-card-actions">
        <button
          type="button"
          className="collectable-send-btn"
          title={action}
          aria-label={action}
          disabled={busy}
          onClick={() => onImport(item.outpoint)}
        >
          <DownloadIcon size={14} />
          {importLabel(spot)}
        </button>
        <SelectionCheckbox
          className="collect-select--inline"
          checked={selected}
          disabled={busy}
          label={`${selected ? 'Deselect' : 'Select'} ${name}`}
          onChange={(checked) => onSelect(item, checked)}
        />
      </div>
    </li>
  )
})

/** Collect's list row with Import in place of Send. */
const ImportListItem = memo(function ImportListItem({ item, selected, spot, locked, onImport, onSelect }: CardProps) {
  const name = itemName(item)
  const action = `${importLabel(spot).replace('…', '')} ${name}`
  const busy = locked || spot != null
  return (
    <li
      className="connected-app-row collectable-row"
      data-aeon-part="item"
      data-aeon-state={cardState(spot, selected)}
    >
      <button
        type="button"
        className="connected-app-main collectable-row-main"
        aria-pressed={selected}
        disabled={busy}
        onClick={() => onSelect(item, !selected)}
      >
        <div className="collectable-media collectable-media-sm">
          <ItemArt item={item} size={48} />
        </div>
        <div className="connected-app-body">
          <strong className="connected-app-name">{name}</strong>
          <span className="connected-app-host" aria-hidden={item.app ? undefined : true}>
            {itemHost(item)}
          </span>
        </div>
      </button>
      <div className="collectable-row-actions">
        <button
          type="button"
          className="collectable-send-btn collectable-send-btn--row"
          title={action}
          aria-label={action}
          disabled={busy}
          onClick={() => onImport(item.outpoint)}
        >
          <DownloadIcon size={14} />
        </button>
        <SelectionCheckbox
          className="collect-select--row"
          checked={selected}
          disabled={busy}
          label={`${selected ? 'Deselect' : 'Select'} ${name}`}
          onChange={(checked) => onSelect(item, checked)}
        />
      </div>
    </li>
  )
})

function SkeletonItem({ view }: { view: CollectionView }) {
  return view === 'grid' ? (
    <li className="collection-grid-card collectable-card" data-aeon-part="item" data-aeon-state="loading">
      <div className="collection-grid-main collectable-main">
        <div className="collectable-media">
          <Skeleton className="skeleton-qr" width={120} height={120} radius={8} />
        </div>
        <SkeletonLine width="70%" />
        <SkeletonLine width="45%" height={10} />
      </div>
    </li>
  ) : (
    <li className="connected-app-row collectable-row" data-aeon-part="item" data-aeon-state="loading">
      <div className="connected-app-main collectable-row-main">
        <div className="collectable-media collectable-media-sm">
          <Skeleton className="skeleton-qr" width={48} height={48} radius={6} />
        </div>
        <div className="connected-app-body">
          <SkeletonLine width="60%" />
          <SkeletonLine width="35%" height={10} />
        </div>
      </div>
    </li>
  )
}

/**
 * One page stream of items, windowed like Collect's. Nearing the end of
 * what is loaded asks the chart for the next page.
 */
function ImportItems({
  items,
  view,
  columns,
  more,
  reading,
  selected,
  moving,
  waiting,
  locked,
  onImport,
  onSelect,
  onMore,
}: ItemActions & {
  items: readonly ImportItem[]
  view: CollectionView
  columns: number
  more: boolean
  reading: boolean
  selected: ReadonlySet<string>
  moving: ReadonlySet<string>
  waiting: ReadonlySet<string>
  locked: boolean
  onMore: () => void
}) {
  const listRef = useRef<HTMLUListElement>(null)
  useScrollIdle(listRef)
  const perRow = view === 'grid' ? columns : 1
  const windowed = useWindowedRange({
    total: items.length,
    itemExtent: view === 'grid' ? 176 : 56,
    columns: perRow,
    overscan: 6,
    scrollRef: listRef,
  })
  const nearEnd = windowed.end >= items.length - perRow * 4
  useEffect(() => {
    if (more && !reading && nearEnd) onMore()
  }, [more, reading, nearEnd, onMore])
  const Item = view === 'grid' ? ImportGridItem : ImportListItem
  const visible = items.slice(windowed.start, windowed.end)
  return (
    <ul
      className={view === 'grid' ? 'collection-grid' : 'connected-app-list'}
      data-aeon-part="items"
      ref={listRef}
      aria-busy={reading || undefined}
      style={
        windowed.padStart > 0 || windowed.padEnd > 0
          ? { paddingTop: windowed.padStart, paddingBottom: windowed.padEnd }
          : undefined
      }
    >
      {visible.map((item) => (
        <Item
          key={item.outpoint}
          item={item}
          selected={selected.has(item.outpoint)}
          spot={moving.has(item.outpoint) ? 'moving' : waiting.has(item.outpoint) ? 'waiting' : null}
          locked={locked}
          onImport={onImport}
          onSelect={onSelect}
        />
      ))}
      {reading && windowed.end >= items.length
        ? Array.from({ length: items.length === 0 ? SKELETON_CARDS : perRow }, (_, i) => (
            <SkeletonItem key={`skeleton-${i}`} view={view} />
          ))
        : null}
    </ul>
  )
}

function shelfTitle(shelf: ImportItemShelf): string {
  if (shelf.signer) return `${shelf.label} · signed by ${shelf.signer}, as the index reports it`
  if (shelf.collectionId) return `${shelf.label} · collection ${shelf.collectionId}`
  return shelf.label
}

/** Collect's issuer accordion: face pile, issuer, count, and a select box for the whole shelf. */
const ImportShelf = memo(function ImportShelf({
  shelf,
  selectedCount,
  gathering,
  locked,
  onSelectShelf,
  children,
}: {
  shelf: ImportItemShelf
  selectedCount: number
  gathering: boolean
  locked: boolean
  onSelectShelf: (group: string, checked: boolean) => void
  children: ReactNode
}) {
  const state = selectedCount === 0 ? 'none' : selectedCount >= shelf.count ? 'all' : 'some'
  return (
    <Accordion.Item
      value={shelf.key}
      className="collect-collection"
      data-aeon-part="shelf"
      data-aeon-state={shelf.kind}
      data-selected={state === 'none' ? undefined : state}
    >
      <div className="collect-collection-head">
        <Accordion.ItemTrigger value={shelf.key} className="collect-collection-trigger">
          <CollectFacepile faces={shelf.faces} />
          <span className="collect-collection-body">
            <strong className="collect-collection-name" title={shelfTitle(shelf)}>
              <span className="collect-collection-name-text">{shelf.label}</span>
            </strong>
            <span className="collect-collection-meta">
              {shelf.signer ? <SignerFingerprint address={shelf.signer} className="collect-issuer-fingerprint" /> : null}
              {groupQuantityLabel({ quantity: shelf.count, provenCount: 0 })}
              {selectedCount > 0 ? ` · ${selectedCount.toLocaleString()} selected` : ''}
            </span>
          </span>
          <Accordion.ItemIndicator className="collect-collection-indicator" aria-hidden>
            ▾
          </Accordion.ItemIndicator>
        </Accordion.ItemTrigger>
        <SelectionCheckbox
          className="collect-select--group"
          checked={state === 'all'}
          mixed={state === 'some'}
          disabled={locked || gathering}
          label={`${state === 'all' ? 'Deselect' : 'Select'} ${shelf.label}`}
          onChange={(checked) => onSelectShelf(shelf.key, checked)}
        />
      </div>
      <Accordion.ItemContent value={shelf.key} className="collect-collection-body-content">
        <section className="collect-nested-collection">{children}</section>
      </Accordion.ItemContent>
    </Accordion.Item>
  )
})

/**
 * A saved source's items, shelved by issuer like Collect. Every face is
 * `importItemBrowserMachine`; names, art and signers are the index's view.
 */
export function ImportItemBrowser(props: { sourceId: string; label: string; onBack: () => void }) {
  const [snapshot, send] = useMachine(importItemBrowserMachine, {
    input: { ports: PORTS, sourceId: props.sourceId },
  })
  const { context } = snapshot
  const view = useSyncExternalStore(subscribeView, readView)
  const selected = useMemo(() => new Set(context.selected.map((s) => s.outpoint)), [context.selected])
  const perShelf = useMemo(() => selectedPerShelf(context.selected), [context.selected])
  const total = shelvedTotal(context.shelves)
  const checking = snapshot.matches({ sync: 'checking' })
  const confirming = snapshot.matches({ move: 'confirming' })
  const locked = confirming
  const run = context.queue.run
  const { moving, waiting } = useMemo(() => queuedOutpoints(context.queue), [context.queue])
  const reading = snapshot.matches({ page: 'reading' })
  const searching = context.query.trim() !== ''
  const firstRead = snapshot.matches({ shelves: 'reading' }) && context.shelves.length === 0
  const selectedCount = context.selected.length
  const notice = context.notice ?? context.queue.report

  const onImport = useCallback((outpoint: string) => send({ type: 'IMPORT', outpoint }), [send])
  const onSelect = useCallback(
    (item: ImportItem, checked: boolean) =>
      send({ type: 'SELECT', items: [{ outpoint: item.outpoint, group: importItemGroup(item).key }], checked }),
    [send],
  )
  const onSelectShelf = useCallback(
    (group: string, checked: boolean) => send({ type: 'SELECT_SHELF', group, checked }),
    [send],
  )
  const onMore = useCallback(() => send({ type: 'MORE' }), [send])
  const onOpen = useCallback((value: string[]) => send({ type: 'OPEN', group: value[0] ?? null }), [send])

  useEffect(() => {
    if (notice) playWalletSound(notice.tone === 'success' ? 'success' : 'error')
  }, [notice])

  // The dock is for choosing. Once confirmed, the run belongs to the page
  // banner and Activity — never a disabled bar parked at the bottom.
  useWalletActionDock(
    confirming
      ? {
          ariaLabel: `Import ${selectedCount} items`,
          tertiary: {
            label: 'Cancel',
            onClick: () => send({ type: 'CANCEL' }),
            icon: <CloseIcon size={18} />,
            tone: 'danger',
          },
          primary: {
            label: `Confirm (${selectedCount.toLocaleString()})`,
            shortLabel: `Confirm (${selectedCount.toLocaleString()})`,
            onClick: () => send({ type: 'CONFIRM' }),
            tone: 'primary',
            icon: <DownloadIcon size={18} />,
            title: `Import ${selectedCount.toLocaleString()} items`,
          },
        }
      : selectedCount > 0
        ? {
            ariaLabel: `${selectedCount} selected items`,
            tertiary: {
              label: 'Cancel',
              onClick: () => send({ type: 'CLEAR' }),
              icon: <CloseIcon size={18} />,
              tone: 'danger',
            },
            primary: {
              label: `Import (${selectedCount.toLocaleString()})`,
              shortLabel: `Import (${selectedCount.toLocaleString()})`,
              onClick: () => send({ type: 'IMPORT_SELECTED' }),
              tone: 'primary',
              icon: <DownloadIcon size={18} />,
              title: `Import ${selectedCount.toLocaleString()} items`,
            },
          }
        : null,
  )

  const status = checking
    ? `Checking for items… ${total.toLocaleString()} found`
    : `${total.toLocaleString()} item${total === 1 ? '' : 's'}${context.complete ? '' : ' · some not checked yet'}`

  const pageItems = (columns: number) => (
    <ImportItems
      items={context.items}
      view={view}
      columns={columns}
      more={context.more}
      reading={reading}
      selected={selected}
      moving={moving}
      waiting={waiting}
      locked={locked}
      onImport={onImport}
      onSelect={onSelect}
      onMore={onMore}
    />
  )

  return (
    <div data-aeon-part="browser" data-aeon-state={stateToAttr(snapshot.value)}>
      <div className="connected-panel-head">
        <h3 className="confirm-password-title">Items in {props.label}</h3>
        <CollectionViewToggle label="Collectables view" scope="collectables" />
      </div>
      <p className="settings-row-desc" data-aeon-part="sync" aria-live="polite">
        {status}
      </p>

      {context.syncError || context.readError ? (
        <StatusBanner.Root tone="danger" status="failed">
          <StatusBanner.Copy>
            <StatusBanner.Title>{context.syncError ? 'Could not check items' : 'Could not read saved items'}</StatusBanner.Title>
            <StatusBanner.Body>{context.syncError ?? context.readError}</StatusBanner.Body>
          </StatusBanner.Copy>
          <div className="actions">
            <button type="button" className="btn btn-ghost" onClick={() => send({ type: 'RETRY' })}>
              Try again
            </button>
          </div>
        </StatusBanner.Root>
      ) : null}

      {confirming ? (
        <StatusBanner.Root tone="info" status="confirming">
          <StatusBanner.Copy>
            <StatusBanner.Title>Import {selectedCount.toLocaleString()} items?</StatusBanner.Title>
            <StatusBanner.Body>
              They move together, up to 25 in each transaction. The import keeps going if you leave this page.
            </StatusBanner.Body>
          </StatusBanner.Copy>
        </StatusBanner.Root>
      ) : null}

      {run ? (
        <StatusBanner.Root
          tone={context.queue.paused ? 'warning' : 'info'}
          status={context.queue.paused ? 'waiting' : run.stopping ? 'stopping' : 'importing'}
          data-aeon-part="run"
        >
          <StatusBanner.Copy>
            <StatusBanner.Title>
              {context.queue.paused
                ? 'Waiting for the last import to clear…'
                : `Importing ${run.done.toLocaleString()} of ${run.total.toLocaleString()}`}
            </StatusBanner.Title>
            <Progress.Root className="history-progress" value={run.done} max={Math.max(1, run.total)}>
              <Progress.Track className="history-progress-track">
                <Progress.Range className="history-progress-range" />
              </Progress.Track>
            </Progress.Root>
            <StatusBanner.Body>Keeps going if you leave this page — Activity shows it too.</StatusBanner.Body>
          </StatusBanner.Copy>
          <div className="actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={run.stopping || run.waiting.length === 0}
              onClick={() => send({ type: 'STOP' })}
            >
              {run.stopping ? 'Stopping…' : 'Stop'}
            </button>
          </div>
        </StatusBanner.Root>
      ) : null}

      {notice ? (
        <StatusBanner.Root tone={notice.tone} status={notice.outcome}>
          <StatusBanner.Copy>
            <StatusBanner.Title>{notice.title}</StatusBanner.Title>
            {notice.body ? <StatusBanner.Body>{notice.body}</StatusBanner.Body> : null}
          </StatusBanner.Copy>
          <div className="actions">
            <button type="button" className="btn btn-ghost" onClick={() => send({ type: 'DISMISS' })}>
              Dismiss
            </button>
          </div>
        </StatusBanner.Root>
      ) : null}

      {total > 0 || searching ? (
        <div className="root-search friends-search" role="search">
          <label className="sr-only" htmlFor="import-item-search">
            Search items
          </label>
          <input
            id="import-item-search"
            type="search"
            placeholder="Search name, app or id"
            value={context.query}
            onChange={(e) => send({ type: 'FILTER', query: e.target.value })}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      ) : null}

      {searching ? (
        context.items.length > 0 || reading ? (
          <section className="collect-items-section" aria-label="Matching items">
            {pageItems(3)}
          </section>
        ) : (
          <div className="friends-empty">
            <strong>No items found</strong>
            <span>Try another name, app, or id.</span>
          </div>
        )
      ) : context.shelves.length > 0 ? (
        <section className="collect-items-section" aria-label="Issuers and items">
          <Accordion.Root
            collapsible
            defaultValue={context.shelves.length === 1 ? [context.shelves[0]!.key] : []}
            onValueChange={onOpen}
            className={context.shelves.length > 1 ? 'collect-collections collect-collections--many' : 'collect-collections'}
          >
            {context.shelves.map((shelf) => (
              <ImportShelf
                key={shelf.key}
                shelf={shelf}
                selectedCount={perShelf.get(shelf.key) ?? 0}
                gathering={context.gathering === shelf.key}
                locked={locked}
                onSelectShelf={onSelectShelf}
              >
                {context.open === shelf.key ? pageItems(2) : null}
              </ImportShelf>
            ))}
          </Accordion.Root>
        </section>
      ) : firstRead || checking ? (
        <ul className={view === 'grid' ? 'collection-grid' : 'connected-app-list'} data-aeon-part="items" aria-busy>
          {Array.from({ length: SKELETON_CARDS }, (_, i) => (
            <SkeletonItem key={i} view={view} />
          ))}
        </ul>
      ) : (
        <p className="settings-row-desc">No items left.</p>
      )}

      <div className="actions">
        <button type="button" className="btn btn-ghost" onClick={props.onBack}>
          Back
        </button>
      </div>
    </div>
  )
}
