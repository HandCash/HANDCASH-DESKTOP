import { Accordion, Button, ListRow, Progress } from '@aeon-ui/react'
import { sliceSetLabel } from '../wallet/brc140IssuedSet'

export type SliceHandoffMethod = 'share' | 'email' | 'copy' | 'download'

export type KeySliceListProps = {
  shares: readonly string[]
  threshold: number
  integrity: string
  /** When this set was issued — the only thing that tells two sets of one wallet apart. */
  issuedAt?: number
  savedIndices: readonly number[]
  /** Optional short labels for the slices. */
  destinations?: readonly string[]
  onHandoff: (
    index: number,
    method: SliceHandoffMethod,
    destination: string,
  ) => void | Promise<void>
  /** Explicit user attestation. Share and copy never mark a slice saved; a file save does once it reads back intact. */
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
  issuedAt,
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
          {issuedAt ? `${sliceSetLabel(issuedAt)} · ` : null}
          Integrity <span className="mono">{integrity}</span> · any {threshold} of {total} from this
          set restore the wallet
        </p>
      </div>

      <Accordion.Root collapsible className="key-slice-accordion">
        {shares.map((share, index) => {
          const saved = savedSet.has(index)
          const itemId = `slice-${index}`
          const destination = assignmentFor(index)
          return (
            <Accordion.Item
              key={share}
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
                  <Button.Root variant="solid"
                    className="btn btn-primary"
                    onClick={() => void onHandoff(index, 'share', destination)}
                  >
                    <Button.Label>Share this slice</Button.Label>
                  </Button.Root>
                  <Button.Root variant="ghost"
                    className="btn btn-ghost"
                    onClick={() => void onHandoff(index, 'copy', destination)}
                  >
                    <Button.Label>Copy</Button.Label>
                  </Button.Root>
                  <Button.Root variant="ghost"
                    className="btn btn-ghost"
                    onClick={() => void onHandoff(index, 'download', destination)}
                  >
                    <Button.Label>Save file</Button.Label>
                  </Button.Root>
                </div>
                <div className="actions split-backup-item-actions">
                  <Button.Root variant="ghost"
                    className={saved ? 'btn btn-ghost' : 'btn btn-primary'}
                    disabled={saved}
                    onClick={() => onConfirmSaved(index)}
                  >
                    <Button.Label>{saved ? 'Saved — confirmed' : 'I saved this slice'}</Button.Label>
                  </Button.Root>
                </div>
              </Accordion.ItemContent>
            </Accordion.Item>
          )
        })}
      </Accordion.Root>
      {onRotateShares ? (
        <div className="actions">
          <Button.Root variant="ghost"
            className="btn btn-ghost"
            disabled={rotateBusy}
            title="Replace this set. Slices from the old set will not combine with the new ones."
            onClick={() => void onRotateShares()}
          >
            <Button.Label>{rotateBusy ? 'Replacing…' : 'Replace slice set'}</Button.Label>
          </Button.Root>
        </div>
      ) : null}
    </div>
  )
}
