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
