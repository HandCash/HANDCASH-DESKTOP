import { Accordion, ListRow, Progress } from '@aeon-ui/react'

export type SliceHandoffMethod = 'share' | 'email' | 'copy' | 'download'

export type KeySliceListProps = {
  shares: readonly string[]
  threshold: number
  integrity: string
  savedIndices: readonly number[]
  /** Optional short labels for the slices. */
  destinations?: readonly string[]
  onHandoff: (
    index: number,
    method: SliceHandoffMethod,
    destination: string,
  ) => void | Promise<void>
  /** Explicit user attestation; handoff actions never mark a slice saved. */
  onConfirmSaved: (index: number) => void
  /** Regenerate a new share set (invalidates previous slices). */
  onRotateShares?: () => void | Promise<void>
  rotateBusy?: boolean
}

/**
 * Simple BRC-140 slice manager. The OS share sheet is the primary handoff;
 * copy and file remain available as universal fallbacks.
 */
export function KeySliceList({
  shares,
  threshold,
  integrity,
  savedIndices,
  destinations = [],
  onHandoff,
  onConfirmSaved,
  onRotateShares,
  rotateBusy = false,
}: KeySliceListProps) {
  const savedSet = new Set(savedIndices)
  const savedCount = savedSet.size
  const complete = savedCount >= threshold
  const total = shares.length

  const assignmentFor = (index: number): string => {
    return destinations[index] ?? `Slice ${index + 1}`
  }

  return (
    <div
      className="key-slice-list"
      data-aeon-scope="key-slice-list"
      data-aeon-state={complete ? 'complete' : 'pending'}
    >
      <div className="key-slice-progress-block" data-aeon-part="progress">
        <div className="key-slice-progress-meta">
          <span className="key-slice-progress-label">
            {complete
              ? `Ready — ${savedCount} of ${total} slices confirmed saved`
              : `${savedCount} of ${threshold} required slices confirmed saved`}
          </span>
          <span className="key-slice-progress-count mono">
            {savedCount}/{threshold}
          </span>
        </div>
        <Progress.Root value={Math.min(savedCount, threshold)} max={threshold} className="key-slice-progress">
          <Progress.Track className="key-slice-progress-track">
            <Progress.Range className="key-slice-progress-range" />
          </Progress.Track>
        </Progress.Root>
        <p className="settings-row-desc">
          Integrity <span className="mono">{integrity}</span> · any {threshold} of {total} restore the
          wallet
        </p>
      </div>

      <Accordion.Root collapsible className="key-slice-accordion">
        {shares.map((share, index) => {
          const saved = savedSet.has(index)
          const itemId = `slice-${index}`
          const destination = assignmentFor(index)
          return (
            <Accordion.Item
              key={`${integrity}-${index}`}
              value={itemId}
              className="key-slice-item"
              data-aeon-state={saved ? 'saved' : 'pending'}
            >
              <Accordion.ItemTrigger value={itemId} className="key-slice-trigger">
                <ListRow.Root as="div" className="key-slice-row">
                  <ListRow.Leading className="key-slice-leading" aria-hidden>
                    {index + 1}
                  </ListRow.Leading>
                  <span className="key-slice-row-text">
                    <ListRow.Label className="key-slice-label">Slice {index + 1}</ListRow.Label>
                    <ListRow.Description className="key-slice-desc">
                      {destination}
                    </ListRow.Description>
                  </span>
                  <ListRow.Trailing className="key-slice-trailing">
                    <span
                      className="key-slice-status"
                      data-aeon-state={saved ? 'saved' : 'pending'}
                      aria-label={saved ? 'Confirmed saved' : 'Not confirmed saved yet'}
                    >
                      {saved ? 'Confirmed' : 'Open'}
                    </span>
                  </ListRow.Trailing>
                  <Accordion.ItemIndicator aria-hidden />
                </ListRow.Root>
              </Accordion.ItemTrigger>
              <Accordion.ItemContent value={itemId} className="key-slice-body">
                <code className="mono split-backup-share">{share}</code>
                <div className="actions split-backup-item-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void onHandoff(index, 'share', destination)}
                  >
                    Share this slice
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void onHandoff(index, 'copy', destination)}
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void onHandoff(index, 'download', destination)}
                  >
                    Save file
                  </button>
                </div>
                <div className="actions split-backup-item-actions">
                  <button
                    type="button"
                    className={saved ? 'btn btn-ghost' : 'btn btn-primary'}
                    disabled={saved}
                    onClick={() => onConfirmSaved(index)}
                  >
                    {saved ? 'Saved — confirmed' : 'I saved this slice'}
                  </button>
                </div>
              </Accordion.ItemContent>
            </Accordion.Item>
          )
        })}
      </Accordion.Root>
      {onRotateShares ? (
        <div className="actions">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={rotateBusy}
            title="Replace this set. Old and new slices cannot be mixed."
            onClick={() => void onRotateShares()}
          >
            {rotateBusy ? 'Replacing…' : 'Replace slice set'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

export type TrustholderDestination = {
  id: string
  label: string
  description: string
  state: 'pending' | 'enrolled' | 'busy' | 'ready'
  enrolledAt?: string
  recommended?: boolean
}

type TrustholderListProps = {
  destinations: TrustholderDestination[]
  recommendedDone: number
  recommendedTotal: number
  offlineShare?: {
    share: string
    integrity: string
    total: number
    index: number
  } | null
  busyId?: string | null
  onDeposit?: (id: string) => void
  onOfflineCopy?: () => void
  onOfflineSave?: () => void
}

/**
 * Independent trustholder rows — each deposits on its own.
 * Recommended: enroll both cloud providers + keep the offline slice.
 */
export function TrustholderDestinationList({
  destinations,
  recommendedDone,
  recommendedTotal,
  offlineShare,
  busyId,
  onDeposit,
  onOfflineCopy,
  onOfflineSave,
}: TrustholderListProps) {
  const offlineReady = Boolean(offlineShare)

  return (
    <div
      className="key-slice-list"
      data-aeon-scope="trustholder-destinations"
      data-aeon-state={
        offlineReady && recommendedDone >= recommendedTotal
          ? 'complete'
          : recommendedDone > 0
            ? 'partial'
            : 'pending'
      }
    >
      <div className="key-slice-progress-block" data-aeon-part="progress">
        <div className="key-slice-progress-meta">
          <span className="key-slice-progress-label">
            {recommendedDone >= recommendedTotal && offlineReady
              ? 'Recommended setup complete'
              : `${recommendedDone} of ${recommendedTotal} recommended providers · each is optional on its own`}
          </span>
        </div>
        <Progress.Root
          value={recommendedDone}
          max={Math.max(recommendedTotal, 1)}
          className="key-slice-progress"
        >
          <Progress.Track className="key-slice-progress-track">
            <Progress.Range className="key-slice-progress-range" />
          </Progress.Track>
        </Progress.Root>
      </div>

      <Accordion.Root collapsible className="key-slice-accordion">
        {destinations.map((dest) => {
          const itemId = dest.id
          const enrolled = dest.state === 'enrolled'
          const busy = busyId === dest.id || dest.state === 'busy'
          return (
            <Accordion.Item
              key={dest.id}
              value={itemId}
              className="key-slice-item"
              data-aeon-state={enrolled ? 'saved' : busy ? 'busy' : 'pending'}
            >
              <Accordion.ItemTrigger value={itemId} className="key-slice-trigger">
                <ListRow.Root as="div" className="key-slice-row">
                  <ListRow.Leading className="key-slice-leading key-slice-leading--cloud" aria-hidden>
                    {dest.label.slice(0, 1)}
                  </ListRow.Leading>
                  <span className="key-slice-row-text">
                    <ListRow.Label className="key-slice-label">
                      {dest.label}
                      {dest.recommended ? (
                        <span className="key-slice-desc"> · recommended</span>
                      ) : null}
                    </ListRow.Label>
                    <ListRow.Description className="key-slice-desc">
                      {dest.description}
                    </ListRow.Description>
                  </span>
                  <ListRow.Trailing className="key-slice-trailing">
                    <span
                      className="key-slice-status"
                      data-aeon-state={enrolled ? 'saved' : busy ? 'pending' : 'pending'}
                    >
                      {enrolled ? 'Deposited' : busy ? 'Working…' : 'Open'}
                    </span>
                  </ListRow.Trailing>
                  <Accordion.ItemIndicator aria-hidden />
                </ListRow.Root>
              </Accordion.ItemTrigger>
              <Accordion.ItemContent value={itemId} className="key-slice-body">
                <p className="settings-row-desc">
                  {enrolled
                    ? 'This provider already holds one slice. You can deposit again to replace it.'
                    : 'Enter your email above, then deposit here. First time registers this email in-app with a code — no browser redirect.'}
                </p>
                <div className="actions split-backup-item-actions">
                  {onDeposit ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => onDeposit(dest.id)}
                    >
                      {busy
                        ? 'Depositing…'
                        : enrolled
                          ? `Re-deposit to ${dest.label}`
                          : `Deposit to ${dest.label}`}
                    </button>
                  ) : null}
                </div>
              </Accordion.ItemContent>
            </Accordion.Item>
          )
        })}
      </Accordion.Root>

      {offlineShare ? (
        <Accordion.Root collapsible defaultValue={['offline']} className="key-slice-accordion">
          <Accordion.Item value="offline" className="key-slice-item" data-aeon-state="ready">
            <Accordion.ItemTrigger value="offline" className="key-slice-trigger">
              <ListRow.Root as="div" className="key-slice-row">
                <ListRow.Leading className="key-slice-leading" aria-hidden>
                  {offlineShare.index + 1}
                </ListRow.Leading>
                <span className="key-slice-row-text">
                  <ListRow.Label className="key-slice-label">Your offline slice</ListRow.Label>
                  <ListRow.Description className="key-slice-desc">
                    Keep this one — not stored with any trustholder
                  </ListRow.Description>
                </span>
                <ListRow.Trailing className="key-slice-trailing">
                  <span className="key-slice-status" data-aeon-state="ready">
                    Reveal
                  </span>
                </ListRow.Trailing>
                <Accordion.ItemIndicator aria-hidden />
              </ListRow.Root>
            </Accordion.ItemTrigger>
            <Accordion.ItemContent value="offline" className="key-slice-body">
              <p className="settings-row-desc">
                Slice {offlineShare.index + 1} of {offlineShare.total} · integrity{' '}
                <span className="mono">{offlineShare.integrity}</span>
              </p>
              <code className="mono split-backup-share">{offlineShare.share}</code>
              <div className="actions split-backup-item-actions">
                <button type="button" className="btn btn-ghost" onClick={onOfflineCopy}>
                  Copy
                </button>
                <button type="button" className="btn btn-primary" onClick={onOfflineSave}>
                  Save file
                </button>
              </div>
            </Accordion.ItemContent>
          </Accordion.Item>
        </Accordion.Root>
      ) : null}
    </div>
  )
}
