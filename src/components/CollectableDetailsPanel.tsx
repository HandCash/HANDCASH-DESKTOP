import { useEffect, useState } from 'react'
import { copyText } from '../wallet/clipboard'
import {
  getCollectable,
  type Collectable,
  type CollectableTrait,
} from '../wallet/collectables'
import { openSendCollectable } from '../wallet/navStore'
import { DeferredImage } from './DeferredImage'

type Props = {
  outpoint: string
}

function MetaRow({ label, value, onCopy, copied }: {
  label: string
  value: string
  onCopy?: () => void
  copied?: boolean
}) {
  if (onCopy) {
    return (
      <div className="field collectable-meta-field">
        <span className="field-static-label">{label}</span>
        <button
          type="button"
          className={`mono wallet-detail-value collectable-full-value${
            copied ? ' is-copied' : ''
          }`}
          title={`Click to copy ${label.toLowerCase()}`}
          onClick={onCopy}
        >
          {copied ? 'Copied' : value}
        </button>
      </div>
    )
  }

  return (
    <div className="field collectable-meta-field">
      <span className="field-static-label">{label}</span>
      <p className="mono wallet-detail-value collectable-full-value">{value}</p>
    </div>
  )
}

function TraitGrid({ title, traits }: { title: string; traits: CollectableTrait[] }) {
  if (traits.length === 0) return null
  return (
    <div className="collectable-traits">
      <span className="field-static-label">{title}</span>
      <ul className="collectable-trait-grid">
        {traits.map((trait) => (
          <li key={`${trait.name}:${trait.value}`} className="collectable-trait">
            <span className="collectable-trait-name">{trait.name}</span>
            <strong className="collectable-trait-value">{trait.value}</strong>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function CollectableDetailsPanel({ outpoint }: Props) {
  const [item, setItem] = useState<Collectable | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState<'origin' | 'outpoint' | null>(null)

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

  const copy = async (kind: 'origin' | 'outpoint', value: string) => {
    if (!(await copyText(value))) return
    setCopied(kind)
    window.setTimeout(() => setCopied(null), 1600)
  }

  if (loading && !item) {
    return <p className="connected-empty-line">Loading…</p>
  }
  if (!item) {
    return <p className="connected-empty-line">Collectable not found</p>
  }

  const infoTraits: CollectableTrait[] = [
    ...(item.app ? [{ name: 'App', value: item.app }] : []),
    ...(item.type ? [{ name: 'Type', value: item.type }] : []),
    ...(item.subType ? [{ name: 'Subtype', value: item.subType }] : []),
    ...(item.mimeType ? [{ name: 'MIME', value: item.mimeType }] : []),
    ...(item.collectionId ? [{ name: 'Collection', value: item.collectionId }] : []),
    ...item.extras,
  ]

  return (
    <div
      className="nav-child-panel collectable-details"
      data-aeon-scope="collectable-details"
    >
      <div className="collectable-details-hero">
        <div className="collectable-media collectable-media-lg">
          <DeferredImage
            src={item.imageUrl}
            alt={item.name}
            width={200}
            height={200}
            skeletonWidth={200}
            skeletonHeight={200}
            skeletonRadius={12}
            skeletonClassName="skeleton-qr"
          />
        </div>
        <div className="collectable-details-copy">
          <h3 className="collectable-details-name">{item.name}</h3>
          {item.app ? <p className="collectable-details-app">{item.app}</p> : null}
        </div>
      </div>

      <MetaRow
        label="Origin"
        value={item.origin}
        copied={copied === 'origin'}
        onCopy={() => void copy('origin', item.origin)}
      />

      <MetaRow
        label="Outpoint"
        value={item.outpoint}
        copied={copied === 'outpoint'}
        onCopy={() => void copy('outpoint', item.outpoint)}
      />

      <TraitGrid title="Traits" traits={item.traits} />
      <TraitGrid title="Details" traits={infoTraits} />

      <div className="actions collectable-details-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => openSendCollectable(item.outpoint)}
        >
          Send
        </button>
      </div>
    </div>
  )
}
