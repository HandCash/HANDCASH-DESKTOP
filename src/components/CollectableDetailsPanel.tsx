import { useEffect, useRef, useState } from 'react'
import { MetricStrip } from '@aeon-ui/ui'
import { copyText } from '../wallet/clipboard'
import { isCollectableModel } from '../wallet/collectableMedia'
import {
  copyCollectableImage,
  saveCollectableImage,
} from '../wallet/imageHandoff'
import { saveCollectableModel } from '../wallet/modelHandoff'
import {
  abandonCollectable,
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
import { getGenesisFailure, getProvenVerdict } from '../wallet/provenCache'
import {
  isOutpointSending, inFlightVerb,
  subscribePaymentProgress,
} from '../wallet/paymentProgress'
import { subscribeAppActivity } from '../wallet/appActivity'

import {
  clearNavChild,
  openBurnCollectable,
  openSendCollectable,
} from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { toastError } from '../wallet/toast'
import { isItemSent } from '../wallet/sentItemGuard'
import { CollectablesIcon, CopyIcon, DownloadIcon, SendIcon, WarningIcon } from './icons'
import { DeferredImage } from './DeferredImage'
import { CollectableSendingMark } from './CollectableSendingMark'
import { EmptyState } from './EmptyState'
import { DeferredModelViewer } from './DeferredModelViewer'

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
  if (
    item.authenticity === 'brc150' ||
    getProvenVerdict(item.outpoint)?.tier === 'brc150'
  ) {
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
  // A tip the wallet already gave up on reads as "unprovable", not "not yet
  // done" — otherwise an item that can never earn a badge is indistinguishable
  // from one still waiting its turn.
  const failure = getGenesisFailure(item.outpoint)
  if (failure?.kind === 'invalid') {
    return {
      label: 'Cannot be verified',
      tone: 'unproven',
      title: `BRC-150 lineage ${failure.reason}`,
    }
  }
  return {
    label: 'Unverified identity',
    tone: 'unproven',
    title: failure
      ? `Not proven yet — ${failure.reason}`
      : 'Identity is a chain/indexer claim and has not been cryptographically proven',
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
  const [abandoning, setAbandoning] = useState(false)
  const [imageBusy, setImageBusy] = useState<'copy' | 'save' | null>(null)
  const mediaRef = useRef<HTMLDivElement>(null)

  useEffect(() => subscribeVerificationProgress(setVerification), [])
  useEffect(
    () =>
      subscribePaymentProgress(() => {
        setSending(isOutpointSending(outpoint))
      }),
    [outpoint],
  )
  useEffect(
    () =>
      subscribeAppActivity(() => {
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
    if (!item) return
    if (getProvenVerdict(item.outpoint)?.tier === 'brc150') return
    if (item.authenticity !== 'unproven') return
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
    const spent = isItemSent(outpoint)
    return (
      <EmptyState
        icon={<CollectablesIcon size={22} />}
        title={spent ? 'Already sent' : 'Item unavailable'}
        body={
          spent
            ? 'This collectable is no longer in your wallet — it was sent recently or is already spent on chain.'
            : 'This collectable is no longer in the wallet or could not be loaded.'
        }
      />
    )
  }

  const isModel = isCollectableModel({ mimeType: item.mimeType, url: item.imageUrl })
  const inFlight = inFlightVerb(item.outpoint)
  const burning = sending && /^burn/i.test(inFlight ?? '')
  const detailRows: CollectableTrait[] = [
    ...(item.app ? [{ name: 'App', value: item.app }] : []),
    ...(item.type ? [{ name: 'Type', value: item.type }] : []),
    ...(item.subType ? [{ name: 'Subtype', value: item.subType }] : []),
    ...(item.mimeType ? [{ name: 'MIME', value: item.mimeType }] : []),
    ...item.extras,
  ]

  const startSend = () => {
    if (sending || item.covenantLocked) return
    playWalletSound('soft')
    openSendCollectable(item.outpoint)
  }

  const paintedImg = () => mediaRef.current?.querySelector('img') ?? null

  const copyImage = () => {
    if (!item.imageUrl || imageBusy) return
    setImageBusy('copy')
    void copyCollectableImage({
      url: item.imageUrl,
      mimeHint: item.mimeType,
      paintedImg: paintedImg(),
    }).finally(() => setImageBusy(null))
  }

  const saveImage = () => {
    if (!item.imageUrl || imageBusy) return
    setImageBusy('save')
    void saveCollectableImage({
      url: item.imageUrl,
      name: item.name,
      mimeHint: item.mimeType,
      paintedImg: paintedImg(),
    }).finally(() => setImageBusy(null))
  }

  const saveModel = () => {
    if (!item.imageUrl || imageBusy) return
    setImageBusy('save')
    void saveCollectableModel({
      url: item.imageUrl,
      name: item.name,
      mimeType: item.mimeType,
    }).finally(() => setImageBusy(null))
  }

  const startAbandon = () => {
    if (abandoning || sending) return
    setAbandoning(true)
    playWalletSound('soft')
    void abandonCollectable(item.outpoint)
      .then(() => {
        clearNavChild()
      })
      .catch((err) => {
        toastError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        setAbandoning(false)
      })
  }

  const authenticity = authenticityView(item, verification)

  return (
    <div
      className="nav-child-panel collectable-details"
      data-aeon-scope="collectable-details"
      data-aeon-state={sending ? 'sending' : 'ready'}
      data-sending={sending ? 'true' : undefined}
    >
      <div className={`collectable-details-hero${isModel ? ' is-model' : ''}`}>
        <div
          className={
            isModel
              ? 'collectable-model-stage'
              : 'collectable-media collectable-media-md'
          }
          ref={mediaRef}
        >
          {isModel ? (
            <DeferredModelViewer key={item.imageUrl} src={item.imageUrl} alt={item.name} />
          ) : (
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
              retainDecoded
              fallback={
                <span className="collectable-media-fallback" aria-hidden>
                  <CollectablesIcon size={40} />
                </span>
              }
            />
          )}
          <CollectableSendingMark sending={sending} verb={inFlightVerb(item.outpoint) ?? 'Sending'} />
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
          {item.covenantLocked ? (
            <p className="collectable-details-app">
              Stuck covenant tip (legacy). It cannot be sent. Remove it
              from this wallet — the sat stays locked on chain.
            </p>
          ) : null}
          <div className="actions collectable-details-actions">
            {item.covenantLocked ? (
              <button
                type="button"
                className="btn btn-secondary btn-icon"
                onClick={startAbandon}
                disabled={abandoning}
                aria-busy={abandoning || undefined}
              >
                {abandoning ? 'Removing…' : 'Remove from wallet'}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-icon"
                onClick={startSend}
                disabled={sending}
                aria-busy={sending && !burning ? true : undefined}
              >
                <SendIcon size={14} />
                {sending && !burning ? `${inFlight ?? 'Sending'}…` : 'Send item'}
              </button>
            )}
            {item.imageUrl && isModel ? (
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                onClick={saveModel}
                disabled={Boolean(imageBusy)}
                aria-busy={imageBusy === 'save' || undefined}
              >
                <DownloadIcon size={14} />
                {imageBusy === 'save' ? 'Saving…' : 'Save model'}
              </button>
            ) : item.imageUrl ? (
              <>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  onClick={copyImage}
                  disabled={Boolean(imageBusy)}
                  aria-busy={imageBusy === 'copy' || undefined}
                >
                  <CopyIcon size={14} />
                  {imageBusy === 'copy' ? 'Copying…' : 'Copy image'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  onClick={saveImage}
                  disabled={Boolean(imageBusy)}
                  aria-busy={imageBusy === 'save' || undefined}
                >
                  <DownloadIcon size={14} />
                  {imageBusy === 'save' ? 'Saving…' : 'Save image'}
                </button>
              </>
            ) : null}
            {/* Destructive action is always last, on items and on tokens. */}
            {item.covenantLocked ? null : (
              <button
                type="button"
                className={`btn btn-ghost btn-icon asset-burn-trigger asset-burn-last${burning ? ' is-burning' : ''}`}
                onClick={() => {
                  if (burning) return
                  playWalletSound('soft')
                  openBurnCollectable(item.outpoint)
                }}
                disabled={sending}
                aria-busy={burning || undefined}
              >
                <WarningIcon size={14} />
                {burning ? 'Burning…' : 'Burn item'}
              </button>
            )}
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
