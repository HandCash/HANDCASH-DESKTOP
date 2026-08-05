import { useMemo, useState } from 'react'
import { Accordion, ListRow, Progress } from '@aeon-ui/react'
import { BRC140_DESTINATION_HINTS } from '../wallet/brc140Backup'

export type SliceHandoffMethod = 'email' | 'copy' | 'download'

export type KeySliceListProps = {
  shares: readonly string[]
  threshold: number
  integrity: string
  savedIndices: readonly number[]
  /** Optional destination labels — defaults to BRC-140 transport hints. */
  destinations?: readonly string[]
  onHandoff: (
    index: number,
    method: SliceHandoffMethod,
    destination: string,
  ) => void | Promise<void>
  /** Regenerate a new share set (invalidates previous slices). */
  onRotateShares?: () => void | Promise<void>
  rotateBusy?: boolean
}

function rotateArray<T>(items: readonly T[], offset: number): T[] {
  if (items.length === 0) return []
  const n = ((offset % items.length) + items.length) % items.length
  return [...items.slice(n), ...items.slice(0, n)]
}

/**
 * Flexible BRC-140 slice manager — destinations cycle per row, bulk cycle,
 * rotate-all for a new integrity set, and handoff actions per slice.
 */
export function KeySliceList({
  shares,
  threshold,
  integrity,
  savedIndices,
  destinations = BRC140_DESTINATION_HINTS,
  onHandoff,
  onRotateShares,
  rotateBusy = false,
}: KeySliceListProps) {
  const savedSet = new Set(savedIndices)
  const savedCount = savedSet.size
  const complete = savedCount >= threshold
  const total = shares.length

  /** Global destination rotation (cycle all assignments together). */
  const [destOffset, setDestOffset] = useState(0)
  /** Extra per-slice nudge on top of the global offset. */
  const [sliceNudge, setSliceNudge] = useState<number[]>(() => shares.map(() => 0))

  const destPool = useMemo(
    () => (destinations.length > 0 ? [...destinations] : [...BRC140_DESTINATION_HINTS]),
    [destinations],
  )

  const assignmentFor = (index: number): string => {
    const nudge = sliceNudge[index] ?? 0
    const pool = rotateArray(destPool, destOffset + nudge)
    return pool[index % pool.length] ?? `Safe place ${index + 1}`
  }

  const cycleAll = (dir: 1 | -1) => {
    setDestOffset((n) => n + dir)
  }

  const cycleSlice = (index: number, dir: 1 | -1) => {
    setSliceNudge((prev) => {
      const next = [...prev]
      while (next.length < total) next.push(0)
      next[index] = (next[index] ?? 0) + dir
      return next
    })
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
              ? `Ready — ${savedCount} of ${total} slices handed off`
              : `${savedCount} of ${threshold} required slices handed off`}
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
          wallet · assign each slice a different place
        </p>
      </div>

      <div className="key-slice-toolbar" role="toolbar" aria-label="Slice tools">
        <button
          type="button"
          className="btn btn-ghost"
          title="Shift every destination assignment"
          onClick={() => cycleAll(-1)}
        >
          ← Destinations
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          title="Shift every destination assignment the other way"
          onClick={() => cycleAll(1)}
        >
          Destinations →
        </button>
        {onRotateShares ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={rotateBusy}
            title="Create a brand-new share set. Old slices will not mix with these."
            onClick={() => void onRotateShares()}
          >
            {rotateBusy ? 'Rotating…' : 'Rotate all slices'}
          </button>
        ) : null}
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
                      aria-label={saved ? 'Handed off' : 'Not handed off yet'}
                    >
                      {saved ? 'Done' : 'Open'}
                    </span>
                  </ListRow.Trailing>
                  <Accordion.ItemIndicator aria-hidden />
                </ListRow.Root>
              </Accordion.ItemTrigger>
              <Accordion.ItemContent value={itemId} className="key-slice-body">
                <div className="key-slice-dest-cycle">
                  <span className="settings-row-desc">Destination</span>
                  <div className="actions key-slice-dest-actions">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      aria-label="Previous destination"
                      title="Previous destination"
                      onClick={(e) => {
                        e.preventDefault()
                        cycleSlice(index, -1)
                      }}
                    >
                      ←
                    </button>
                    <span className="key-slice-dest-label">{destination}</span>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      aria-label="Next destination"
                      title="Next destination"
                      onClick={(e) => {
                        e.preventDefault()
                        cycleSlice(index, 1)
                      }}
                    >
                      →
                    </button>
                  </div>
                </div>
                <code className="mono split-backup-share">{share}</code>
                <div className="actions split-backup-item-actions">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void onHandoff(index, 'email', destination)}
                  >
                    Email
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
                    className="btn btn-primary"
                    onClick={() => void onHandoff(index, 'download', destination)}
                  >
                    Save file
                  </button>
                </div>
              </Accordion.ItemContent>
            </Accordion.Item>
          )
        })}
      </Accordion.Root>
    </div>
  )
}

export type TrustholderDestination = {
  id: string
  label: string
  description: string
  state: 'pending' | 'enrolled' | 'ready'
  enrolledAt?: string
}

type TrustholderListProps = {
  destinations: TrustholderDestination[]
  offlineShare?: {
    share: string
    integrity: string
    total: number
    index: number
  } | null
  onOfflineCopy?: () => void
  onOfflineSave?: () => void
}

/**
 * Cloud trustholder rows + optional offline slice (same list vocabulary as KeySliceList).
 */
export function TrustholderDestinationList({
  destinations,
  offlineShare,
  onOfflineCopy,
  onOfflineSave,
}: TrustholderListProps) {
  const cloudSaved = destinations.filter((d) => d.state === 'enrolled').length
  const cloudTotal = destinations.length
  const offlineReady = Boolean(offlineShare)

  return (
    <div
      className="key-slice-list"
      data-aeon-scope="trustholder-destinations"
      data-aeon-state={offlineReady ? 'complete' : cloudSaved > 0 ? 'partial' : 'pending'}
    >
      <div className="key-slice-progress-block" data-aeon-part="progress">
        <div className="key-slice-progress-meta">
          <span className="key-slice-progress-label">
            {offlineReady
              ? 'Cloud slices deposited — save your offline copy'
              : `${cloudSaved} of ${cloudTotal} cloud trustholders enrolled`}
          </span>
        </div>
        <Progress.Root
          value={cloudSaved + (offlineReady ? 1 : 0)}
          max={cloudTotal + 1}
          className="key-slice-progress"
        >
          <Progress.Track className="key-slice-progress-track">
            <Progress.Range className="key-slice-progress-range" />
          </Progress.Track>
        </Progress.Root>
      </div>

      <ul className="key-slice-static-list" role="list">
        {destinations.map((dest) => (
          <li key={dest.id} className="key-slice-static-item" data-aeon-state={dest.state}>
            <ListRow.Root as="div" className="key-slice-row">
              <ListRow.Leading className="key-slice-leading key-slice-leading--cloud" aria-hidden>
                ☁
              </ListRow.Leading>
              <span className="key-slice-row-text">
                <ListRow.Label className="key-slice-label">{dest.label}</ListRow.Label>
                <ListRow.Description className="key-slice-desc">{dest.description}</ListRow.Description>
              </span>
              <ListRow.Trailing className="key-slice-trailing">
                <span className="key-slice-status" data-aeon-state={dest.state}>
                  {dest.state === 'enrolled'
                    ? 'Deposited'
                    : dest.state === 'ready'
                      ? 'Ready'
                      : 'Pending'}
                </span>
              </ListRow.Trailing>
            </ListRow.Root>
          </li>
        ))}
      </ul>

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
                    Keep this one — not stored in the cloud
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
