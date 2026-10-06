import { useMemo } from 'react'
import { MetricStrip, Progress, StatusBanner } from '@aeon-ui/react'
import { formatBsv } from '../../wallet/session'
import { estimateItemMigrateCost } from '../../wallet/phraseSweep'
import { MIGRATE_HINTS_URL } from '../../wallet/walletConfig'
import {
  IMPORT_ITEMS_PER_TX,
  IMPORT_SOURCE_LABELS,
  describeImportHold,
  formatTokenAmount,
  planSweep,
  type HeldTally,
  type ImportHoldReason,
  type ImportedSource,
  type RecoveryHintsOffer,
} from '../../wallet/import'
import { ImportItemBrowser } from './ImportItemBrowser'

export type SourceFace =
  | 'viewing'
  | 'awaitingHints'
  | 'scanning'
  | 'browsing'
  | 'reviewing'
  | 'sweeping'
  | 'confirmingRemove'
  | 'removing'

function HeldList({ held }: { held: HeldTally }) {
  const rows = (Object.entries(held) as Array<[ImportHoldReason, number | undefined]>).filter(
    ([, count]) => (count ?? 0) > 0,
  )
  if (rows.length === 0) return null
  return (
    <ul className="settings-row-desc" data-aeon-part="held">
      {rows.map(([reason, count]) => (
        <li key={reason}>
          <strong>{count?.toLocaleString()}</strong> — {describeImportHold(reason)}
        </li>
      ))}
    </ul>
  )
}

/**
 * HandCash history for the scan, only where HandCash's own UTXO set could not
 * be used. `offer` is null where the migrate page cannot reach this shell.
 */
function HandCashHistory(props: {
  offer: RecoveryHintsOffer | null
  face: SourceFace
  onAsk: () => void
  onRescan: () => void
  onCancel: () => void
}) {
  const { offer, face } = props
  if (!offer || offer.kind === 'none') return null
  if (face === 'awaitingHints') {
    return (
      <StatusBanner.Root tone="info" status="awaiting" data-aeon-part="hints">
        <StatusBanner.Copy>
          <StatusBanner.Title>Waiting for your HandCash history</StatusBanner.Title>
          <StatusBanner.Body>
            Sign in on the HandCash page that opened in your browser. The scan starts as soon as your
            transaction list arrives. Your keys never leave this device.
          </StatusBanner.Body>
        </StatusBanner.Copy>
        <div className="actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void window.handcash?.openExternal?.(MIGRATE_HINTS_URL)}
          >
            Open the page again
          </button>
          <button type="button" className="btn btn-ghost" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </StatusBanner.Root>
    )
  }
  if (face !== 'viewing' || offer.kind === 'used') return null
  if (offer.kind === 'ready') {
    return (
      <StatusBanner.Root tone="info" status="ready" data-aeon-part="hints">
        <StatusBanner.Copy>
          <StatusBanner.Title>Your HandCash history is here</StatusBanner.Title>
          <StatusBanner.Body>
            {offer.items.toLocaleString()} item{offer.items === 1 ? '' : 's'} and{' '}
            {offer.txids.toLocaleString()} transaction{offer.txids === 1 ? '' : 's'}. Rescan to read only
            where your coins and items are now.
          </StatusBanner.Body>
        </StatusBanner.Copy>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={props.onRescan}>
            Rescan with it
          </button>
        </div>
      </StatusBanner.Root>
    )
  }
  return (
    <StatusBanner.Root tone="info" status={offer.kind} data-aeon-part="hints">
      <StatusBanner.Copy>
        <StatusBanner.Title>Faster scan from your HandCash account</StatusBanner.Title>
        <StatusBanner.Body>
          {offer.kind === 'mismatch'
            ? `HandCash sent the history of $${offer.hinted}, but these keys belong to $${offer.saved}. Sign in as $${offer.saved}.`
            : 'Sign in to HandCash in your browser and it sends your transaction list here, so the scan reads only the addresses you used. Nothing moves.'}
        </StatusBanner.Body>
      </StatusBanner.Copy>
      <div className="actions">
        <button type="button" className="btn btn-ghost" onClick={props.onAsk}>
          Sign in to HandCash
        </button>
      </div>
    </StatusBanner.Root>
  )
}

/**
 * One saved source. Every face is a `legacyImportMachine` state under
 * `source`; this component only renders it and forwards intents.
 */
export function ImportSourceView(props: {
  source: ImportedSource
  face: SourceFace
  progress: string | null
  percent: number | null
  error: string | null
  hintsOffer: RecoveryHintsOffer | null
  onAskHints: () => void
  onBack: () => void
  onBrowse: () => void
  onRescan: () => void
  onReview: () => void
  onConfirm: () => void
  onCancel: () => void
  onRemove: () => void
  onPause: () => void
}) {
  const { source, face } = props
  const plan = useMemo(() => planSweep(source), [source])
  const working = face === 'scanning' || face === 'sweeping'
  const totals = plan.totals
  const scan = source.scan
  const itemCost = estimateItemMigrateCost({
    itemCount: totals.itemCount,
    itemsPerTx: IMPORT_ITEMS_PER_TX,
  })
  const movable = totals.cashCount > 0 || totals.itemCount > 0 || totals.tokens.length > 0
  const offer = scan?.via === 'handcash-utxo-set' ? null : props.hintsOffer

  if (face === 'browsing') {
    return (
      <div data-aeon-part="source" data-aeon-state={face}>
        <ImportItemBrowser sourceId={source.id} label={source.label} onBack={props.onCancel} />
      </div>
    )
  }

  return (
    <div data-aeon-part="source" data-aeon-state={face}>
      <div className="confirm-password-copy">
        <h3 className="confirm-password-title">{source.label}</h3>
        <p className="confirm-password-lede">
          {IMPORT_SOURCE_LABELS[source.kind]}
          {scan
            ? ` · scanned ${new Date(scan.at).toLocaleDateString()}${scan.complete ? '' : ' (incomplete)'}`
            : ' · not scanned yet'}
        </p>
      </div>

      <HandCashHistory
        offer={offer}
        face={face}
        onAsk={props.onAskHints}
        onRescan={props.onRescan}
        onCancel={props.onCancel}
      />

      {scan ? (
        <MetricStrip.Root density="loose" data-aeon-part="totals">
          <MetricStrip.Chip>
            <MetricStrip.Value>{formatBsv(totals.cashSats)}</MetricStrip.Value>
            <MetricStrip.Label>BSV</MetricStrip.Label>
          </MetricStrip.Chip>
          <MetricStrip.Chip>
            <MetricStrip.Value>
              {totals.itemCount.toLocaleString()}
              {totals.itemCountCapped ? '+' : ''}
            </MetricStrip.Value>
            <MetricStrip.Label>Items</MetricStrip.Label>
          </MetricStrip.Chip>
          <MetricStrip.Chip>
            <MetricStrip.Value>{totals.tokens.length}</MetricStrip.Value>
            <MetricStrip.Label>Tokens</MetricStrip.Label>
          </MetricStrip.Chip>
        </MetricStrip.Root>
      ) : null}

      {totals.partial > 0 ? (
        <StatusBanner.Root tone="warning" status="partial">
          <StatusBanner.Copy>
            <StatusBanner.Body>
              {totals.partial} address{totals.partial === 1 ? '' : 'es'} could not be read fully —
              numbers are a floor. Rescan later.
            </StatusBanner.Body>
          </StatusBanner.Copy>
        </StatusBanner.Root>
      ) : null}

      {totals.tokens.length > 0 ? (
        <ul className="settings-row-desc" data-aeon-part="tokens">
          {totals.tokens.map((token) => (
            <li key={token.id ?? token.tick ?? token.sym}>
              <strong>{formatTokenAmount(token.amount, token.dec)}</strong> {token.sym}
            </li>
          ))}
        </ul>
      ) : null}

      {working ? (
        <div className="history-progress-block settings-sweep-progress" data-aeon-part="work" data-aeon-state={face}>
          <p className="settings-hint">{props.progress ?? (face === 'scanning' ? 'Scanning…' : 'Sweeping…')}</p>
          <Progress.Root
            value={props.percent ?? 0}
            max={100}
            indeterminate={props.percent == null}
            className="history-progress"
          >
            <Progress.Track className="history-progress-track">
              <Progress.Range className="history-progress-range" />
            </Progress.Track>
          </Progress.Root>
          <div className="actions">
            <button type="button" className="btn btn-ghost" onClick={props.onPause}>
              Pause after this step
            </button>
          </div>
        </div>
      ) : null}

      {face === 'reviewing' ? (
        <div className="settings-row" data-aeon-part="review">
          <h4 className="settings-row-label">Import everything compatible</h4>
          <ul className="settings-row-desc">
            {totals.cashCount > 0 ? (
              <li>
                {formatBsv(totals.cashSats)} BSV from {totals.cashCount} output
                {totals.cashCount === 1 ? '' : 's'}
              </li>
            ) : null}
            {totals.itemCount > 0 ? (
              <li>
                {totals.itemCount.toLocaleString()}
                {totals.itemCountCapped ? '+' : ''} item
                {totals.itemCount === 1 ? '' : 's'} — ~{itemCost.transactions.toLocaleString()}{' '}
                transaction{itemCost.transactions === 1 ? '' : 's'}, ~{formatBsv(itemCost.feeSats)} BSV
                in fees paid by this wallet
              </li>
            ) : null}
            {totals.tokens.map((token) => (
              <li key={token.id ?? token.sym}>
                {formatTokenAmount(token.amount, token.dec)} {token.sym} (valid outputs only)
              </li>
            ))}
          </ul>
          {Object.keys(totals.held).length > 0 ? (
            <>
              <p className="settings-row-desc">Stays at the source:</p>
              <HeldList held={totals.held} />
            </>
          ) : null}
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={props.onConfirm}>
              Import all
            </button>
            <button type="button" className="btn btn-ghost" onClick={props.onCancel}>
              Back
            </button>
          </div>
        </div>
      ) : null}

      {face === 'confirmingRemove' || face === 'removing' ? (
        <StatusBanner.Root tone="danger" status="remove">
          <StatusBanner.Copy>
            <StatusBanner.Title>Remove {source.label}?</StatusBanner.Title>
            <StatusBanner.Body>
              The keys are deleted from this device. Anything not imported stays on chain, reachable
              only with your own copy of these keys.
            </StatusBanner.Body>
          </StatusBanner.Copy>
          <div className="actions">
            <button
              type="button"
              className="btn btn-danger"
              disabled={face === 'removing'}
              onClick={props.onConfirm}
            >
              Remove
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={face === 'removing'}
              onClick={props.onCancel}
            >
              Keep
            </button>
          </div>
        </StatusBanner.Root>
      ) : null}

      {props.error ? (
        <p className="error" role="alert">
          {props.error}
        </p>
      ) : null}

      {source.lastSweep ? (
        <p className="settings-row-desc" data-aeon-part="last-sweep">
          Last import {new Date(source.lastSweep.at).toLocaleDateString()} ·{' '}
          {formatBsv(source.lastSweep.cashSats)} BSV · {source.lastSweep.items.toLocaleString()} items
          {source.lastSweep.tokens.length > 0
            ? ` · ${source.lastSweep.tokens.map((t) => t.sym).join(', ')}`
            : ''}
          {source.lastSweep.failed > 0 ? ` · ${source.lastSweep.failed} failed` : ''}
          {source.lastSweep.notes.length > 0 ? ` — ${source.lastSweep.notes.join(' ')}` : ''}
        </p>
      ) : null}

      {face === 'viewing' ? (
        <div className="actions" data-aeon-part="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={totals.itemCount === 0}
            onClick={props.onBrowse}
          >
            Browse items
          </button>
          <button type="button" className="btn btn-ghost" disabled={!movable} onClick={props.onReview}>
            Import all…
          </button>
          <button type="button" className="btn btn-ghost" onClick={props.onRescan}>
            Rescan
          </button>
          <button type="button" className="btn btn-ghost" onClick={props.onBack}>
            Back
          </button>
        </div>
      ) : null}

      {face === 'viewing' ? (
        <div className="actions" data-aeon-part="danger">
          <button type="button" className="btn btn-ghost" onClick={props.onRemove}>
            Remove this wallet
          </button>
        </div>
      ) : null}
    </div>
  )
}
