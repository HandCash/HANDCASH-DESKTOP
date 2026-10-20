import { Button } from '@aeon-ui/react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import {
  assetBurnUiMachine,
  type AssetBurnUiSnapshot,
} from '../machines/assetBurnUiMachine'
import { burnOneSat } from '../wallet/burn'
import {
  estimateBurnEconomics,
  type BurnEconomics,
} from '../wallet/burnEconomics'
import { CopyableError } from './CopyableError'
import { isCollectableModel } from '../wallet/collectableMedia'
import {
  abandonCollectable,
  getCachedCollectables,
  getCollectable,
  subscribeCollectables,
  type Collectable,
} from '../wallet/collectables'
import {
  getDisplayCurrency,
  subscribeDisplayCurrency,
  type DisplayCurrency,
} from '../wallet/displayCurrency'
import {
  formatSecondaryFromSats,
  getCachedUsdPerBsv,
  subscribeUsdRate,
} from '../wallet/fx'
import {
  clearNavChild,
  openCollectableDetails,
} from '../wallet/navStore'
import {
  isOutpointSending,
  inFlightVerb,
  subscribePaymentProgress,
} from '../wallet/paymentProgress'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import type { IssuerAsset } from '../hooks/useIssuerView'
import { AssetIssuers } from './AssetIssuers'
import { DeferredImage } from './DeferredImage'
import { EmptyState } from './EmptyState'
import { CheckIcon, CloseIcon, CollectablesIcon, FireIcon } from './icons'
import { WalletRequestTemplate } from './WalletRequestTemplate'

/** Explicit target — a burn never guesses which protocol it is destroying. */
export type BurnTarget =
  | { kind: 'collectable'; outpoint: string }
  | { kind: 'collectables'; outpoints: string[] }

type Props = {
  target: BurnTarget
}

export function BurnAssetPanel({ target }: Props) {
  if (target.kind === 'collectables') {
    return <BurnCollectablesPanel outpoints={target.outpoints} />
  }
  return <BurnCollectablePanel outpoint={target.outpoint} />
}

type Stage = 'editing' | 'confirming' | 'burning' | 'forgetting' | 'failure'

function stageOf(snapshot: AssetBurnUiSnapshot): Stage {
  if (snapshot.matches('confirming')) return 'confirming'
  if (snapshot.matches('forgetting')) return 'forgetting'
  if (snapshot.matches('burning') || snapshot.matches('done')) return 'burning'
  if (snapshot.matches('failure')) return 'failure'
  // `closed` only paints for the frame before the mount effect opens the chart.
  return 'editing'
}

function BurnShell({
  stage,
  media,
  issuers,
  eyebrow,
  title,
  subtitle,
  amountLabel,
  confirmSubtitle,
  economics,
  grossLabel,
  refusal,
  error,
  canReview,
  onReview,
  onConfirm,
  onBack,
  onCancel,
  alternativeActionLabel,
  alternativeNote,
  onAlternativeAction,
}: {
  stage: Stage
  media: ReactNode
  /** The assets being burned, so their issuers show on both steps. */
  issuers: readonly IssuerAsset[]
  eyebrow: string
  title: string
  subtitle: string
  /** What the confirm step restates — fixed, with no field beside it. */
  amountLabel: string
  /** Second line on confirm: what survives the burn, not a repeat of the name. */
  confirmSubtitle: string
  economics: BurnEconomics
  grossLabel: string
  refusal?: string | null
  error?: string | null
  canReview: boolean
  onReview: () => void
  onConfirm: () => void
  onBack: () => void
  onCancel: () => void
  alternativeActionLabel?: string
  alternativeNote?: string
  onAlternativeAction?: () => void
}) {
  const [usdPerBsv, setUsdPerBsv] = useState<number | null>(() =>
    getCachedUsdPerBsv()
  )
  const [currency, setCurrency] = useState<DisplayCurrency>(() =>
    getDisplayCurrency()
  )

  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])
  useEffect(() => subscribeDisplayCurrency(setCurrency), [])
  useEffect(() => {
    if (stage === 'failure') playWalletSound('error')
  }, [stage])

  const recovered = economics.recoverableSats
  const net = recovered - economics.estimatedFeeSats
  const netSecondary =
    net !== 0
      ? formatSecondaryFromSats(Math.abs(net), currency, usdPerBsv)
      : null
  /** A burn or a local forget is in flight; every confirm-stage control locks. */
  const busy = stage === 'burning' || stage === 'forgetting'
  const forgetting = stage === 'forgetting'
  const showConfirm = stage === 'confirming' || busy

  const hero = (
    <div className="send-amount-hero send-collectable-hero">
      <div className="send-collectable-preview">
        <span className="burn-hero-media" aria-hidden>
          {media}
        </span>
        <div>
          <p className="send-eyebrow burn-eyebrow">
            <FireIcon size={12} />
            {showConfirm ? 'You’re burning' : eyebrow}
          </p>
          <strong className="collectable-details-name">
            {showConfirm ? amountLabel : title}
          </strong>
          <AssetIssuers assets={issuers} />
          {showConfirm ? null : (
            <p className="collectable-details-app">{subtitle}</p>
          )}
        </div>
      </div>
    </div>
  )

  const breakdown = (
    <dl className="burn-breakdown">
      {showConfirm ? null : (
        <>
          <div>
            <dt>{grossLabel}</dt>
            <dd>{economics.grossAssetSats.toLocaleString()} sats</dd>
          </div>
          <div>
            <dt>Protocol outputs</dt>
            <dd>{economics.protocolOutputSats.toLocaleString()} sats</dd>
          </div>
        </>
      )}
      <div>
        <dt>Recovered to Pay</dt>
        <dd>{recovered.toLocaleString()} sats</dd>
      </div>
      <div>
        <dt>Network fee</dt>
        <dd>about {economics.estimatedFeeSats.toLocaleString()} sats</dd>
      </div>
      <div className="burn-breakdown-net">
        <dt>Effect on Pay</dt>
        <dd>
          {net >= 0 ? '+' : '−'}
          {Math.abs(net).toLocaleString()} sats
          {netSecondary ? <em> ≈ {netSecondary}</em> : null}
        </dd>
      </div>
    </dl>
  )

  const actions =
    stage === 'failure'
      ? {
          ariaLabel: 'Burn failure actions',
          secondary: {
            label: 'Close',
            onClick: onCancel,
            icon: <CloseIcon size={18} />,
          },
          primary: {
            label: 'Edit',
            onClick: onBack,
            icon: <CheckIcon size={18} />,
            tone: 'primary' as const,
          },
        }
      : showConfirm
        ? {
            ariaLabel: 'Confirm permanent burn',
            secondary: {
              label: 'Back',
              onClick: onBack,
              disabled: busy,
              icon: <CloseIcon size={18} />,
              tone: 'danger' as const,
            },
            primary: {
              label: stage === 'burning' ? 'Burning…' : 'Confirm burn',
              onClick: onConfirm,
              disabled: busy,
              icon: <FireIcon size={18} />,
              tone: 'danger' as const,
            },
          }
        : {
            ariaLabel: 'Review burn',
            secondary: {
              label: 'Cancel',
              onClick: onCancel,
              disabled: busy,
              icon: <CloseIcon size={18} />,
              tone: 'danger' as const,
            },
            primary: {
              label: 'Review',
              onClick: onReview,
              disabled: !canReview || busy,
              icon: <CheckIcon size={18} />,
              tone: 'danger' as const,
            },
          }

  return (
    <WalletRequestTemplate
      scope="asset-burn"
      state={stateToAttr(stage)}
      actions={actions}
      className="nav-child-panel send-panel burn-panel"
    >
      {stage === 'failure' ? (
        <div className="send-stage send-stage-failure">
          <div className="send-stage-body send-stage-body-center">
            <p className="send-status-title">Couldn’t burn</p>
            <p className="error send-failure-error">
              <CopyableError
                as="span"
                className="copyable-error"
                role="alert"
                text={error ?? 'The burn was refused.'}
              >
                {error ?? 'The burn was refused.'}
              </CopyableError>
            </p>
          </div>
        </div>
      ) : showConfirm ? (
        <div className="send-stage send-stage-confirm">
          <div className="send-layout send-layout-confirm">
            {hero}
            <div className="send-side">
              <p className="send-confirm-to">{confirmSubtitle}</p>
              {breakdown}
              <p className="burn-note">
                Destroyed on chain for good — no undo, and History backup cannot
                bring it back.
              </p>
              {alternativeNote ? (
                <p className="burn-note">{alternativeNote}</p>
              ) : null}
              {alternativeActionLabel && onAlternativeAction ? (
                <Button.Root variant="ghost"
                  className="btn btn-ghost burn-forget"
                  disabled={busy}
                  aria-busy={forgetting || undefined}
                  onClick={onAlternativeAction}
                >
                  <Button.Label>{forgetting ? 'Forgetting…' : alternativeActionLabel}</Button.Label>
                </Button.Root>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <div className="send-stage send-stage-edit">
          <div className="send-layout">
            {hero}
            <div className="send-side">
              {refusal ? (
                <CopyableError
                  as="p"
                  className="copyable-error"
                  role="status"
                  text={refusal}
                >
                  {refusal}
                </CopyableError>
              ) : null}
              {breakdown}
              <p className="burn-note">
                Only eligible physical sats come back as wallet change. The
                asset itself ends here.
              </p>
            </div>
          </div>
        </div>
      )}
    </WalletRequestTemplate>
  )
}

function BurnCollectablesPanel({ outpoints }: { outpoints: string[] }) {
  const stableOutpoints = [...new Set(outpoints)]
  const [items, setItems] = useState<Collectable[]>(() => {
    const wanted = new Set(stableOutpoints)
    return getCachedCollectables().filter((item) => wanted.has(item.outpoint))
  })
  const [loading, setLoading] = useState(items.length !== stableOutpoints.length)
  const [snapshot, event] = useMachine(assetBurnUiMachine)

  useEffect(() => {
    event({ type: 'OPEN' })
  }, [event])

  useEffect(() => {
    const wanted = new Set(stableOutpoints)
    const pick = (list: Collectable[]) =>
      stableOutpoints
        .map((outpoint) => list.find((item) => item.outpoint === outpoint))
        .filter((item): item is Collectable => item != null)
    const unsubscribe = subscribeCollectables((list) => setItems(pick(list)))
    let cancelled = false
    void Promise.all(stableOutpoints.map((outpoint) => getCollectable(outpoint)))
      .then((found) => {
        if (!cancelled) {
          setItems(found.filter((item): item is Collectable => item != null))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      unsubscribe()
      wanted.clear()
    }
    // The navigation payload is immutable for this panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stableOutpoints.join('|')])

  if (loading && items.length !== stableOutpoints.length) {
    return (
      <div
        className="nav-child-panel send-panel burn-panel"
        data-aeon-scope="asset-burn"
        data-aeon-state="loading"
        aria-busy="true"
        aria-label="Loading selected items"
      />
    )
  }

  if (items.length !== stableOutpoints.length) {
    return (
      <EmptyState
        icon={<CollectablesIcon size={28} />}
        title="Some items are no longer available"
        body="Return to Collect and choose items still held by this wallet."
      />
    )
  }

  const busyItem = items.find((item) => isOutpointSending(item.outpoint))
  const lockedItem = items.find((item) => item.covenantLocked)
  const refusal = lockedItem
    ? `${lockedItem.name} is covenant locked and cannot be burned.`
    : busyItem
      ? `${busyItem.name} is already being processed.`
      : null
  const economics = estimateBurnEconomics({
    inputCount: items.length,
    protocolOutputCount: 0,
    recoveryOutput: true,
    grossAssetSats: items.reduce((sum, item) => sum + (item.satoshis || 1), 0),
  })

  const confirm = () => {
    if (refusal) return
    event({ type: 'CONFIRM' })
    clearNavChild()
    void burnOneSat(stableOutpoints)
      .then((result) => {
        playWalletSound('success')
        toastSuccess(
          `${items.length} collectables burned`,
          `${result.recoveredSatoshis.toLocaleString()} physical sats recovered into Pay${
            result.feeSatoshis != null
              ? `; ${result.feeSatoshis.toLocaleString()} sats network fee.`
              : ' before fees.'
          }`,
        )
      })
      .catch((err) => {
        playWalletSound('error')
        toastError('Batch burn failed', err instanceof Error ? err.message : String(err))
      })
  }

  return (
    <BurnShell
      stage={stageOf(snapshot)}
      media={
        <span className="burn-batch-preview" aria-hidden>
          {items.slice(0, 3).map((item) => (
            <DeferredImage
              key={item.outpoint}
              src={item.imageUrl}
              alt=""
              width={40}
              height={40}
              skeletonRadius={6}
              fallback={<CollectablesIcon size={20} />}
              retainDecoded
            />
          ))}
        </span>
      }
      issuers={items}
      eyebrow="Burn collectables"
      title={`${items.length} selected items`}
      subtitle="One permanent on-chain action"
      amountLabel={`${items.length} collectables`}
      confirmSubtitle="Every selected item and its BRC-150 lineage"
      economics={economics}
      grossLabel="Asset sats selected"
      refusal={refusal}
      error={snapshot.context.error}
      canReview={refusal == null}
      onReview={() => {
        playWalletSound('soft')
        event({ type: 'REVIEW' })
      }}
      onConfirm={confirm}
      onBack={() => event({ type: 'BACK' })}
      onCancel={clearNavChild}
    />
  )
}

function BurnCollectablePanel({ outpoint }: { outpoint: string }) {
  const [item, setItem] = useState<Collectable | null>(
    () => getCachedCollectables().find((i) => i.outpoint === outpoint) ?? null
  )
  const [loading, setLoading] = useState(() => item == null)
  const [sending, setSending] = useState(() => isOutpointSending(outpoint))
  const issuerAssets = useMemo(() => (item ? [item] : []), [item])
  const [snapshot, event] = useMachine(assetBurnUiMachine)

  useEffect(() => {
    event({ type: 'OPEN' })
  }, [event])

  useEffect(
    () =>
      subscribePaymentProgress(() => setSending(isOutpointSending(outpoint))),
    [outpoint]
  )

  useEffect(() => {
    let cancelled = false
    void getCollectable(outpoint)
      .then((found) => {
        if (!cancelled) setItem(found ?? null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    const unsubscribe = subscribeCollectables((list) => {
      const found = list.find((i) => i.outpoint === outpoint)
      if (found) setItem(found)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [outpoint])

  if (!item) {
    return loading ? (
      <div
        className="nav-child-panel send-panel burn-panel"
        data-aeon-scope="asset-burn"
        data-aeon-state="loading"
        aria-busy="true"
        aria-label="Loading item"
      />
    ) : (
      <EmptyState
        icon={<CollectablesIcon size={28} />}
        title="Item not on this device"
        body="This collectable is no longer held by this wallet."
      />
    )
  }

  const refusal = item.covenantLocked
    ? 'This tip is covenant locked, so the wallet cannot spend it.'
    : sending
      ? (inFlightVerb(outpoint) ?? 'Sending') === 'Burning'
        ? 'This item is being burned. Wait for it to finish first.'
        : 'This item is mid-send. Wait for it to settle first.'
      : null
  const economics = estimateBurnEconomics({
    inputCount: 1,
    protocolOutputCount: 0,
    recoveryOutput: true,
  })
  const isModel = isCollectableModel({
    mimeType: item.mimeType,
    url: item.imageUrl,
  })

  const confirm = () => {
    event({ type: 'CONFIRM' })
    clearNavChild()
    void burnOneSat([item.outpoint])
      .then((result) => {
        playWalletSound('success')
        toastSuccess(
          'Collectable burned',
          `${result.recoveredSatoshis.toLocaleString()} physical sat${
            result.recoveredSatoshis === 1 ? '' : 's'
          } recovered into Pay${
            result.feeSatoshis != null
              ? `; ${result.feeSatoshis.toLocaleString()} sats network fee.`
              : ' before fees.'
          }`
        )
      })
      .catch((err) => {
        playWalletSound('error')
        toastError(
          'Burn failed',
          err instanceof Error ? err.message : String(err)
        )
      })
  }

  const forget = () => {
    // The chart only accepts FORGET from `confirming`; a burn or forget already
    // in flight ignores it, so the exclusivity lives in the chart, not a flag.
    if (sending || !snapshot.matches('confirming')) return
    event({ type: 'FORGET' })
    void abandonCollectable(item.outpoint)
      .then(() => {
        event({ type: 'FORGOTTEN' })
        playWalletSound('success')
        toastSuccess(
          'Collectable forgotten',
          'Removed from this wallet without broadcasting a burn transaction.'
        )
        clearNavChild()
      })
      .catch((err) => {
        event({
          type: 'FAIL',
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }

  return (
    <BurnShell
      stage={stageOf(snapshot)}
      media={
        isModel ? (
          <span className="burn-hero-model" aria-hidden>
            <CollectablesIcon size={26} />
          </span>
        ) : (
          <DeferredImage
            className="burn-hero-image"
            src={item.imageUrl}
            alt={item.name}
            width={48}
            height={48}
            skeletonRadius={8}
            retainDecoded
          />
        )
      }
      issuers={issuerAssets}
      eyebrow="Burn collectable"
      title={item.name}
      subtitle={item.app ? `${item.app} · one of a kind` : 'One of a kind'}
      amountLabel={item.name}
      confirmSubtitle="This item, and its BRC-150 lineage with it"
      economics={economics}
      grossLabel="Asset sats selected"
      refusal={refusal}
      error={snapshot.context.error}
      canReview={refusal == null}
      onReview={() => {
        playWalletSound('soft')
        event({ type: 'REVIEW' })
      }}
      onConfirm={confirm}
      onBack={() => event({ type: 'BACK' })}
      onCancel={() => openCollectableDetails(item.outpoint)}
      alternativeActionLabel="Forget from wallet"
      alternativeNote="Or remove it from this wallet without spending it. Nothing is broadcast."
      onAlternativeAction={forget}
    />
  )
}
