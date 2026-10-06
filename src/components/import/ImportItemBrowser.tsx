import { useMemo, useRef } from 'react'
import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { StatusBanner } from '@aeon-ui/react'
import {
  filteredImportItems,
  importItemBrowserMachine,
  type ImportItemPorts,
} from '../../machines/importItemBrowserMachine'
import { importOneItem, listImportItems, type ImportItem } from '../../wallet/import'
import { playWalletSound } from '../../wallet/soundService'
import { DeferredImage } from '../DeferredImage'
import { Skeleton, SkeletonLine } from '../Skeleton'
import { CollectablesIcon, DownloadIcon } from '../icons'
import { useWindowedRange } from '../uiFeed/useWindowedRange'

const PORTS: ImportItemPorts = {
  list: (sourceId, onItems, shouldStop) => listImportItems({ sourceId, onItems, shouldStop }),
  importOne: async (sourceId, item) => {
    const result = await importOneItem({ sourceId, item })
    playWalletSound(result.kind === 'moved' ? 'success' : 'error')
    return result
  },
}

const SKELETON_CARDS = 6

function mediaLabel(item: ImportItem): string {
  const type = item.mimeType?.split(';')[0]?.trim()
  return type ? type.replace(/^(image|text|model|application)\//, '') : 'unknown media'
}

/** Same card as Collect's grid; the action is Import instead of Send. */
function ImportItemCard(props: { item: ImportItem; importing: string | null; onImport: () => void }) {
  const { item } = props
  const busy = props.importing === item.outpoint
  const name = item.name ?? 'Untitled'
  const label = busy ? `Importing ${name}` : `Import ${name}`
  return (
    <li
      className="collection-grid-card collectable-card"
      data-aeon-part="item"
      data-aeon-state={busy ? 'importing' : 'idle'}
    >
      <div className="collection-grid-main collectable-main">
        <div className="collectable-media">
          <DeferredImage
            src={item.imageUrl ?? undefined}
            alt={name}
            width={120}
            height={120}
            skeletonWidth={120}
            skeletonHeight={120}
            skeletonRadius={8}
            skeletonClassName="skeleton-qr"
            decoding="async"
            fallback={
              <span className="collectable-media-fallback" aria-hidden>
                <CollectablesIcon size={36} />
              </span>
            }
          />
        </div>
        <strong className="collection-grid-name" title={name}>
          {name}
        </strong>
        <span className="collection-grid-host" title={item.outpoint}>
          {item.imageUrl ? `${item.outpoint.slice(0, 8)}…${item.outpoint.slice(-4)}` : mediaLabel(item)}
        </span>
      </div>
      <div className="collectable-card-actions">
        <button
          type="button"
          className="collectable-send-btn"
          title={label}
          aria-label={label}
          disabled={props.importing !== null}
          onClick={props.onImport}
        >
          <DownloadIcon size={14} />
          {busy ? 'Importing…' : 'Import'}
        </button>
      </div>
    </li>
  )
}

function SkeletonCard() {
  return (
    <li className="collection-grid-card collectable-card" data-aeon-part="item" data-aeon-state="loading">
      <div className="collection-grid-main collectable-main">
        <div className="collectable-media">
          <Skeleton className="skeleton-qr" width={120} height={120} radius={8} />
        </div>
        <SkeletonLine width="70%" />
        <SkeletonLine width="45%" height={10} />
      </div>
    </li>
  )
}

/**
 * The saved source's items, one move at a time. Every face is
 * `importItemBrowserMachine`; names and art are the 1Sat index's view.
 */
export function ImportItemBrowser(props: { sourceId: string; label: string; onBack: () => void }) {
  const [snapshot, send] = useMachine(importItemBrowserMachine, {
    input: { ports: PORTS, sourceId: props.sourceId },
  })
  const { context } = snapshot
  const loading = snapshot.matches({ list: 'loading' })
  const matching = useMemo(() => filteredImportItems(context), [context.items, context.query])
  const listRef = useRef<HTMLUListElement>(null)
  const windowed = useWindowedRange({
    total: matching.length,
    itemExtent: 220,
    columns: 3,
    overscan: 4,
    scrollRef: listRef,
  })
  const visible = matching.slice(windowed.start, windowed.end)
  const importing = context.importing?.outpoint ?? null
  const count = context.items.length

  return (
    <div data-aeon-part="browser" data-aeon-state={stateToAttr(snapshot.value)}>
      <div className="confirm-password-copy">
        <h3 className="confirm-password-title">Items in {props.label}</h3>
        <p className="confirm-password-lede">
          {loading
            ? `Finding items… ${count.toLocaleString()} so far`
            : `${count.toLocaleString()} item${count === 1 ? '' : 's'}${context.complete ? '' : ' — some could not be read, rescan later'}`}
          {' · each import is its own transaction, paid by this wallet'}
        </p>
      </div>

      {snapshot.matches({ list: 'failed' }) ? (
        <StatusBanner.Root tone="danger" status="failed">
          <StatusBanner.Copy>
            <StatusBanner.Title>Could not list items</StatusBanner.Title>
            <StatusBanner.Body>{context.error}</StatusBanner.Body>
          </StatusBanner.Copy>
          <div className="actions">
            <button type="button" className="btn btn-ghost" onClick={() => send({ type: 'RETRY' })}>
              Try again
            </button>
          </div>
        </StatusBanner.Root>
      ) : null}

      {context.notice ? (
        <StatusBanner.Root tone={context.notice.tone} status={context.notice.outcome}>
          <StatusBanner.Copy>
            <StatusBanner.Title>{context.notice.title}</StatusBanner.Title>
            <StatusBanner.Body>{context.notice.body}</StatusBanner.Body>
          </StatusBanner.Copy>
          <div className="actions">
            <button type="button" className="btn btn-ghost" onClick={() => send({ type: 'DISMISS' })}>
              Dismiss
            </button>
          </div>
        </StatusBanner.Root>
      ) : null}

      {count > 0 ? (
        <div className="field" data-aeon-part="field">
          <label htmlFor="import-item-filter">Search by name</label>
          <input
            id="import-item-filter"
            type="search"
            value={context.query}
            onChange={(e) => send({ type: 'FILTER', query: e.target.value })}
            placeholder="Name or outpoint"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      ) : null}

      {count === 0 && loading ? (
        <ul className="collection-grid" data-aeon-part="items" aria-busy>
          {Array.from({ length: SKELETON_CARDS }, (_, i) => (
            <SkeletonCard key={i} />
          ))}
        </ul>
      ) : matching.length > 0 ? (
        <ul
          className="collection-grid"
          data-aeon-part="items"
          ref={listRef}
          aria-busy={loading || undefined}
          style={
            windowed.padStart > 0 || windowed.padEnd > 0
              ? { paddingTop: windowed.padStart, paddingBottom: windowed.padEnd }
              : undefined
          }
        >
          {visible.map((item) => (
            <ImportItemCard
              key={item.outpoint}
              item={item}
              importing={importing}
              onImport={() => send({ type: 'IMPORT', outpoint: item.outpoint })}
            />
          ))}
        </ul>
      ) : snapshot.matches({ list: 'failed' }) || loading ? null : (
        <p className="settings-row-desc">
          {context.query.trim() ? 'No item matches that search.' : 'No items left in this wallet.'}
        </p>
      )}

      <div className="actions">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={snapshot.matches({ move: 'importing' })}
          onClick={props.onBack}
        >
          Back
        </button>
      </div>
    </div>
  )
}
