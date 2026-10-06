import { useMemo } from 'react'
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
import { Skeleton } from '../Skeleton'
import { CollectablesIcon } from '../icons'

const PORTS: ImportItemPorts = {
  list: (sourceId) => listImportItems({ sourceId }),
  importOne: async (sourceId, item) => {
    const result = await importOneItem({ sourceId, item })
    playWalletSound(result.kind === 'moved' ? 'success' : 'error')
    return result
  },
}

function mediaLabel(item: ImportItem): string {
  const type = item.mimeType?.split(';')[0]?.trim()
  return type ? type.replace(/^(image|text|model|application)\//, '') : 'unknown media'
}

function ItemTile(props: { item: ImportItem; importing: string | null; onImport: () => void }) {
  const { item } = props
  const busy = props.importing === item.outpoint
  const name = item.name ?? 'Untitled'
  const fallback = (
    <span className="import-item-fallback" aria-hidden>
      <CollectablesIcon size={22} />
      <small>{mediaLabel(item)}</small>
    </span>
  )
  return (
    <li data-aeon-part="item" data-aeon-state={busy ? 'importing' : 'idle'}>
      {item.imageUrl ? (
        <DeferredImage
          src={item.imageUrl}
          alt={name}
          width={120}
          height={120}
          skeletonWidth="100%"
          skeletonHeight="100%"
          skeletonRadius={10}
          decoding="async"
          fallback={fallback}
        />
      ) : (
        fallback
      )}
      <strong title={name}>{name}</strong>
      <span className="mono" title={item.outpoint}>
        {item.outpoint.slice(0, 8)}…{item.outpoint.slice(-4)}
      </span>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={props.importing !== null}
        onClick={props.onImport}
      >
        {busy ? 'Importing…' : 'Import'}
      </button>
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
  const matching = useMemo(
    () => filteredImportItems(context),
    [context.items, context.query],
  )
  const visible = matching.slice(0, context.shown)
  const importing = context.importing?.outpoint ?? null

  return (
    <div data-aeon-part="browser" data-aeon-state={stateToAttr(snapshot.value)}>
      <div className="confirm-password-copy">
        <h3 className="confirm-password-title">Items in {props.label}</h3>
        <p className="confirm-password-lede">
          {snapshot.matches('loading')
            ? 'Finding items…'
            : `${context.items.length.toLocaleString()} item${context.items.length === 1 ? '' : 's'}${context.complete ? '' : ' so far — some could not be read'} · each import is its own transaction, paid by this wallet`}
        </p>
      </div>

      {snapshot.matches('failed') ? (
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
          {snapshot.matches('ready') ? (
            <div className="actions">
              <button type="button" className="btn btn-ghost" onClick={() => send({ type: 'DISMISS' })}>
                Dismiss
              </button>
            </div>
          ) : null}
        </StatusBanner.Root>
      ) : null}

      {context.items.length > 0 ? (
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

      {snapshot.matches('loading') ? (
        <ul data-aeon-part="items" aria-busy>
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} data-aeon-part="item" data-aeon-state="loading">
              <Skeleton width="100%" height="100%" radius={10} />
            </li>
          ))}
        </ul>
      ) : visible.length > 0 ? (
        <ul data-aeon-part="items">
          {visible.map((item) => (
            <ItemTile
              key={item.outpoint}
              item={item}
              importing={importing}
              onImport={() => send({ type: 'IMPORT', outpoint: item.outpoint })}
            />
          ))}
        </ul>
      ) : snapshot.matches('failed') ? null : (
        <p className="settings-row-desc">
          {context.query.trim() ? 'No item matches that search.' : 'No items left in this wallet.'}
        </p>
      )}

      <div className="actions">
        {matching.length > visible.length ? (
          <button type="button" className="btn btn-ghost" onClick={() => send({ type: 'MORE' })}>
            Show more ({(matching.length - visible.length).toLocaleString()})
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost"
          disabled={snapshot.matches('importing')}
          onClick={props.onBack}
        >
          Back
        </button>
      </div>
    </div>
  )
}
