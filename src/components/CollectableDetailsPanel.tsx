import { useEffect, useState } from 'react'
import { MetricStrip } from '@aeon-ui/ui'
import { copyText } from '../wallet/clipboard'
import {
  getCollectable,
  subscribeCollectables,
  type Collectable,
  type CollectableTrait,
} from '../wallet/collectables'
import { openSendCollectable } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { CollectablesIcon, SendIcon } from './icons'
import { DeferredImage } from './DeferredImage'
import { EmptyState } from './EmptyState'
import { Skeleton } from './Skeleton'

type Props = {
  outpoint: string
}

function MetaRow({
  label,
  value,
  onCopy,
}: {
  label: string
  value: string
  onCopy: () => void
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <button
          type="button"
          className="mono collectable-meta-copy"
          title={`Click to copy ${label.toLowerCase()}\n${value}`}
          onClick={onCopy}
        >
          {value}
        </button>
      </dd>
    </>
  )
}

function TraitStrip({ title, traits }: { title: string; traits: CollectableTrait[] }) {
  if (traits.length === 0) return null
  return (
    <div className="collectable-traits">
      <span className="field-static-label">{title}</span>
      <MetricStrip.Root density="loose" className="collectable-trait-strip">
        {traits.map((trait) => (
          <MetricStrip.Chip key={`${trait.name}:${trait.value}`}>
            <MetricStrip.Value title={trait.value}>{trait.value}</MetricStrip.Value>
            <MetricStrip.Label>{trait.name}</MetricStrip.Label>
          </MetricStrip.Chip>
        ))}
      </MetricStrip.Root>
    </div>
  )
}

export function CollectableDetailsPanel({ outpoint }: Props) {
  const [item, setItem] = useState<Collectable | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void getCollectable(outpoint)
      .then((next) => {
        if (!cancelled) setItem(next)
      })
      .catch((err) => {
        console.warn('[collectables] details load failed', err)
        if (!cancelled) setItem(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [outpoint])

  // The list reconciles against the address UTXO set after the panel opens, so
  // a tip that turns out to be spent has to leave the detail view too.
  useEffect(
    () =>
      subscribeCollectables((items) => {
        const next = items.find((i) => i.outpoint === outpoint)
        if (next) setItem(next)
      }),
    [outpoint],
  )

  const copy = async (label: string, value: string) => {
    await copyText(value, { label })
  }

  if (loading && !item) {
    return (
      <div
        className="nav-child-panel collectable-details collectable-details-loading"
        data-aeon-scope="collectable-details"
        aria-label="Loading collectable"
        aria-busy="true"
      >
        <div className="collectable-details-hero">
          <Skeleton width={96} height={96} radius={10} />
          <div className="collectable-details-loading-copy">
            <Skeleton width="min(14rem, 72%)" height={20} radius={6} />
            <Skeleton width="min(9rem, 48%)" height={14} radius={5} />
            <Skeleton width={112} height={36} radius={8} />
          </div>
        </div>
        <div className="collectable-details-loading-lines">
          <Skeleton width="100%" height={52} radius={8} />
          <Skeleton width="100%" height={52} radius={8} />
        </div>
      </div>
    )
  }
  if (!item) {
    return (
      <EmptyState
        icon={<CollectablesIcon size={22} />}
        title="Item unavailable"
        body="This collectable is no longer in the wallet or could not be loaded."
      />
    )
  }

  const detailRows: CollectableTrait[] = [
    ...(item.app ? [{ name: 'App', value: item.app }] : []),
    ...(item.type ? [{ name: 'Type', value: item.type }] : []),
    ...(item.subType ? [{ name: 'Subtype', value: item.subType }] : []),
    ...(item.mimeType ? [{ name: 'MIME', value: item.mimeType }] : []),
    ...item.extras,
  ]

  const startSend = () => {
    playWalletSound('soft')
    openSendCollectable(item.outpoint)
  }

  return (
    <div
      className="nav-child-panel collectable-details"
      data-aeon-scope="collectable-details"
    >
      <div className="collectable-details-hero">
        <div className="collectable-media collectable-media-md">
          <DeferredImage
            src={item.imageUrl}
            alt={item.name}
            width={96}
            height={96}
            skeletonWidth={96}
            skeletonHeight={96}
            skeletonRadius={10}
            skeletonClassName="skeleton-qr"
            decoding="async"
          />
        </div>
        <div className="collectable-details-copy">
          <h3 className="collectable-details-name">{item.name}</h3>
          {item.app ? <p className="collectable-details-app">{item.app}</p> : null}
          <div className="actions collectable-details-actions">
            <button type="button" className="btn btn-primary btn-icon" onClick={startSend}>
              <SendIcon size={14} />
              Send item
            </button>
          </div>
        </div>
      </div>

      <TraitStrip title="Traits" traits={item.traits} />
      <TraitStrip title="Details" traits={detailRows} />

      <dl className="collectable-details-meta">
        {item.collectionId ? (
          <MetaRow
            label="Collection"
            value={item.collectionId}
            onCopy={() => void copy('collection', item.collectionId!)}
          />
        ) : null}
        <MetaRow
          label="Origin"
          value={item.origin}
          onCopy={() => void copy('origin', item.origin)}
        />
        <MetaRow
          label="Outpoint"
          value={item.outpoint}
          onCopy={() => void copy('outpoint', item.outpoint)}
        />
      </dl>
    </div>
  )
}
