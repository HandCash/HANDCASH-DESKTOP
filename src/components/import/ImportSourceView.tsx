import { useMemo } from 'react'
import { Button, MetricStrip, Progress, StatusBanner } from '@aeon-ui/react'
import { Badge, ListRow, Separator } from '@aeon-ui/ui'
import { formatBsv } from '../../wallet/session'
import { estimateItemMigrateCost } from '../../wallet/phraseSweep'
import { MIGRATE_HINTS_URL } from '../../wallet/walletConfig'
import {
  IMPORT_ITEMS_PER_TX,
  IMPORT_SOURCE_LABELS,
  describeImportHold,
  planSweep,
  type HeldTally,
  type ImportHoldReason,
  type ImportedSource,
  type RecoveryHintsOffer,
} from '../../wallet/import'
import { ImportItemBrowser } from './ImportItemBrowser'
import { SettingsSection } from '../settings/SettingsSection'
import { ImportSourceIcon } from './importSourceIcons'

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
    ([reason, count]) => (count ?? 0) > 0 && describeImportHold(reason) != null,
  )
  if (rows.length === 0) return null
  return (
    <ul className="settings-list" data-aeon-part="held">
      {rows.map(([reason, count]) => (
        <li key={reason}>
          <ListRow.Root as="div">
            <ListRow.Label>{describeImportHold(reason)}</ListRow.Label>
            <ListRow.Trailing className="mono">{count?.toLocaleString()}</ListRow.Trailing>
          </ListRow.Root>
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
          <Button.Root variant="ghost"
            className="btn btn-ghost"
            onClick={() => void window.handcash?.openExternal?.(MIGRATE_HINTS_URL)}
          >
            <Button.Label>Open the page again</Button.Label>
          </Button.Root>
          <Button.Root variant="ghost" className="btn btn-ghost" onClick={props.onCancel}>
            <Button.Label>Cancel</Button.Label>
          </Button.Root>
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
          <Button.Root variant="solid" className="btn btn-primary" onClick={props.onRescan}>
            <Button.Label>Rescan with it</Button.Label>
          </Button.Root>
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
        <Button.Root variant="ghost" className="btn btn-ghost" onClick={props.onAsk}>
          <Button.Label>Sign in to HandCash</Button.Label>
        </Button.Root>
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
  const movable = totals.cashCount > 0 || totals.itemCount > 0
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
      <header className="import-source-head" data-aeon-part="head">
        <ImportSourceIcon kind={source.kind} size="lg" />
        <div>
          <h3 className="confirm-password-title">{source.label}</h3>
          <p className="confirm-password-lede">{IMPORT_SOURCE_LABELS[source.kind]}</p>
        </div>
        <Badge variant={!scan ? 'accent' : scan.complete ? 'default' : 'danger'} data-aeon-part="scan">
          {!scan
            ? 'Not scanned'
            : scan.complete
              ? `Scanned ${new Date(scan.at).toLocaleDateString()}`
              : 'Scan incomplete'}
        </Badge>
      </header>

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
            <Button.Root variant="ghost" className="btn btn-ghost" onClick={props.onPause}>
              <Button.Label>Pause after this step</Button.Label>
            </Button.Root>
          </div>
        </div>
      ) : null}

      {face === 'reviewing' ? (
        <section data-aeon-part="review">
          <SettingsSection title="Moves into this wallet">
            <ul className="settings-list">
              {totals.cashCount > 0 ? (
                <li>
                  <ListRow.Root as="div">
                    <ListRow.Label>BSV</ListRow.Label>
                    <ListRow.Description>
                      From {totals.cashCount.toLocaleString()} output{totals.cashCount === 1 ? '' : 's'}
                    </ListRow.Description>
                    <ListRow.Trailing className="mono">{formatBsv(totals.cashSats)}</ListRow.Trailing>
                  </ListRow.Root>
                </li>
              ) : null}
              {totals.itemCount > 0 ? (
                <li>
                  <ListRow.Root as="div">
                    <ListRow.Label>Items</ListRow.Label>
                    <ListRow.Description>
                      ~{itemCost.transactions.toLocaleString()} transaction{itemCost.transactions === 1 ? '' : 's'}, ~
                      {formatBsv(itemCost.feeSats)} BSV in fees
                    </ListRow.Description>
                    <ListRow.Trailing className="mono">
                      {totals.itemCount.toLocaleString()}
                      {totals.itemCountCapped ? '+' : ''}
                    </ListRow.Trailing>
                  </ListRow.Root>
                </li>
              ) : null}
            </ul>
          </SettingsSection>
          {Object.keys(totals.held).length > 0 ? (
            <SettingsSection title="Stays where it is">
              <HeldList held={totals.held} />
            </SettingsSection>
          ) : null}
          <div className="actions">
            <Button.Root variant="solid" className="btn btn-primary" onClick={props.onConfirm}>
              <Button.Label>Import all</Button.Label>
            </Button.Root>
            <Button.Root variant="ghost" className="btn btn-ghost" onClick={props.onCancel}>
              <Button.Label>Back</Button.Label>
            </Button.Root>
          </div>
        </section>
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
            <Button.Root variant="solid"
              className="btn btn-danger"
              disabled={face === 'removing'}
              onClick={props.onConfirm}
            >
              <Button.Label>Remove</Button.Label>
            </Button.Root>
            <Button.Root variant="ghost"
              className="btn btn-ghost"
              disabled={face === 'removing'}
              onClick={props.onCancel}
            >
              <Button.Label>Keep</Button.Label>
            </Button.Root>
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
          {source.lastSweep.failed > 0 ? ` · ${source.lastSweep.failed} failed` : ''}
          {source.lastSweep.notes.length > 0 ? ` — ${source.lastSweep.notes.join(' ')}` : ''}
        </p>
      ) : null}

      {face === 'viewing' && scan && !movable ? (
        <p className="settings-hint" data-aeon-part="empty">
          Nothing here to import. Rescan if coins or items arrived since {new Date(scan.at).toLocaleDateString()}.
        </p>
      ) : null}

      {face === 'viewing' ? (
        <div className="actions" data-aeon-part="actions">
          {movable ? (
            <Button.Root variant="solid" className="btn btn-primary" onClick={props.onReview}>
              <Button.Label>Import all…</Button.Label>
            </Button.Root>
          ) : null}
          {totals.itemCount > 0 ? (
            <Button.Root variant="ghost" className="btn btn-ghost" onClick={props.onBrowse}>
              <Button.Label>Choose items</Button.Label>
            </Button.Root>
          ) : null}
          <Button.Root
            variant={movable ? 'ghost' : 'solid'}
            className={movable ? 'btn btn-ghost' : 'btn btn-primary'}
            onClick={props.onRescan}
          >
            <Button.Label>{scan ? 'Rescan' : 'Scan'}</Button.Label>
          </Button.Root>
          <Button.Root variant="ghost" className="btn btn-ghost" onClick={props.onBack}>
            <Button.Label>Back</Button.Label>
          </Button.Root>
        </div>
      ) : null}

      {face === 'viewing' ? <Separator.Root /> : null}

      {face === 'viewing' ? (
        <div className="actions" data-aeon-part="danger">
          <Button.Root variant="ghost" className="btn btn-ghost" onClick={props.onRemove}>
            <Button.Label>Remove this wallet</Button.Label>
          </Button.Root>
        </div>
      ) : null}
    </div>
  )
}
