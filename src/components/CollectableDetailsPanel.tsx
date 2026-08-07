import { useEffect, useState } from 'react'
import { MetricStrip } from '@aeon-ui/ui'
import { copyText } from '../wallet/clipboard'
import {
  getCachedCollectables,
  getCollectable,
  requestCollectableVerification,
  subscribeCollectables,
  type Collectable,
  type CollectableTrait,
} from '../wallet/collectables'
import {
  getVerificationProgress,
  isOutpointVerifying,
  subscribeVerificationProgress,
  type VerificationProgress,
} from '../wallet/verificationProgress'
import {
  isOutpointSending,
  subscribePaymentProgress,
} from '../wallet/paymentProgress'
import { openSendCollectable } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { CollectablesIcon, SendIcon } from './icons'
import { DeferredImage } from './DeferredImage'
import { CollectableSendingMark } from './CollectableSendingMark'
import { EmptyState } from './EmptyState'

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

function authenticityView(
  item: Collectable,
  verification: VerificationProgress,
): { label: string; tone: string; title: string } {
  if (item.authenticity === 'brc150' || item.authenticity === 'brc156') {
    return {
      label: 'Verified · BRC-150',
      tone: 'brc150',
      title: 'BRC-150 tip-to-origin lineage verified',
    }
  }
  if (isOutpointVerifying(item.outpoint, verification)) {
    return {
      label: verification.phase === 'identifying' ? 'Identifying…' : 'Verifying…',
      tone: 'verifying',
      title: verification.detail ?? 'Proving this item’s identity on chain',
    }
  }
  return {
    label: 'Unverified identity',
    tone: 'unproven',
    title:
      'Identity is a chain/indexer claim and has not been cryptographically proven',
  }
}

function cacheHit(outpoint: string): Collectable | null {
  return getCachedCollectables().find((i) => i.outpoint === outpoint) ?? null
}

export function CollectableDetailsPanel({ outpoint }: Props) {
  const [item, setItem] = useState<Collectable | null>(() => cacheHit(outpoint))
  const [loading, setLoading] = useState(() => !cacheHit(outpoint))
  const [verification, setVerification] = useState(() => getVerificationProgress())
  const [sending, setSending] = useState(() => isOutpointSending(outpoint))

  useEffect(() => subscribeVerificationProgress(setVerification), [])
  useEffect(
    () =>
      subscribePaymentProgress(() => {
        setSending(isOutpointSending(outpoint))
      }),
    [outpoint],
  )

  useEffect(() => {
    let cancelled = false
    const cached = cacheHit(outpoint)
    if (cached) {
      setItem(cached)
      setLoading(false)
    } else {
      setItem(null)
      setLoading(true)
    }
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

  // Opening an unverified tip jumps it to the front of the lineage queue so the
  // badge can move from "Unverified" to "Verifying…" while the user is looking.
  useEffect(() => {
    if (!item || item.authenticity !== 'unproven') return
    requestCollectableVerification(item.outpoint)
  }, [item?.outpoint, item?.authenticity])

  const copy = async (label: string, value: string) => {
    await copyText(value, { label })
  }

  // Cache hits paint immediately. Rare cold loads stay blank — no corner/center
  // spinner chrome in the item subcontext.
  if (loading && !item) {
    return (
      <div
        className="nav-child-panel collectable-details"
        data-aeon-scope="collectable-details"
        aria-label="Loading collectable"
        aria-busy="true"
      />
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
    if (sending) return
    playWalletSound('soft')
    openSendCollectable(item.outpoint)
  }

  const authenticity = authenticityView(item, verification)

  return (
    <div
      className="nav-child-panel collectable-details"
      data-aeon-scope="collectable-details"
      data-sending={sending ? 'true' : undefined}
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
          <CollectableSendingMark sending={sending} />
        </div>
        <div className="collectable-details-copy">
          <h3 className="collectable-details-name">{item.name}</h3>
          {item.app ? <p className="collectable-details-app">{item.app}</p> : null}
          <p
            className={`collectable-authenticity collectable-authenticity-${authenticity.tone}`}
            title={authenticity.title}
          >
            {authenticity.tone === 'verifying' ? (
              <span className="collectable-authenticity-busy">
                <span className="collectable-verify-spinner" aria-hidden />
                {authenticity.label}
              </span>
            ) : (
              authenticity.label
            )}
          </p>
          <div className="actions collectable-details-actions">
            <button
              type="button"
              className="btn btn-primary btn-icon"
              onClick={startSend}
              disabled={sending}
              aria-busy={sending || undefined}
            >
              <SendIcon size={14} />
              {sending ? 'Sending…' : 'Send item'}
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
