import { useEffect, useState, type ReactNode } from 'react'
import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import {
  assetBurnUiMachine,
  type AssetBurnUiSnapshot,
} from '../machines/assetBurnUiMachine'
import { burnBsv21, burnOneSat, previewFungibleBurn } from '../wallet/burn'
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
  formatFungibleAmount,
  getFungible,
  listFungibles,
  subscribeFungibles,
  type FungibleToken,
} from '../wallet/fungibles'
import {
  formatSecondaryFromSats,
  getCachedUsdPerBsv,
  subscribeUsdRate,
} from '../wallet/fx'
import {
  clearNavChild,
  openCollectableDetails,
  openFungibleDetails,
} from '../wallet/navStore'
import {
  isOutpointSending,
  subscribePaymentProgress,
} from '../wallet/paymentProgress'
import { parseFungibleSendAmount } from '../wallet/sendFungible'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { DeferredImage } from './DeferredImage'
import { EmptyState } from './EmptyState'
import { FungibleTokenFace } from './FungibleTokenFace'
import { CollectablesIcon, FireIcon } from './icons'

/** Explicit target — a burn never guesses which protocol it is destroying. */
export type BurnTarget =
  | { kind: 'fungible'; tokenId: string }
  | { kind: 'collectable'; outpoint: string }

type Props = {
  target: BurnTarget
}

export function BurnAssetPanel({ target }: Props) {
  return target.kind === 'fungible' ? (
    <BurnFungiblePanel tokenId={target.tokenId} />
  ) : (
    <BurnCollectablePanel outpoint={target.outpoint} />
  )
}

type Stage = 'editing' | 'confirming' | 'burning' | 'failure'

function stageOf(snapshot: AssetBurnUiSnapshot): Stage {
  if (snapshot.matches('confirming')) return 'confirming'
  if (snapshot.matches('burning') || snapshot.matches('done')) return 'burning'
  if (snapshot.matches('failure')) return 'failure'
  // `closed` only paints for the frame before the mount effect opens the chart.
  return 'editing'
}

function BurnShell({
  stage,
  media,
  eyebrow,
  title,
  subtitle,
  amountLabel,
  confirmSubtitle,
  amountField,
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
  alternativeActionBusy = false,
  alternativeNote,
  onAlternativeAction,
}: {
  stage: Stage
  media: ReactNode
  eyebrow: string
  title: string
  subtitle: string
  /** What the confirm step restates — fixed, with no field beside it. */
  amountLabel: string
  /** Second line on confirm: what survives the burn, not a repeat of the name. */
  confirmSubtitle: string
  amountField?: ReactNode
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
  alternativeActionBusy?: boolean
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
  const busy = stage === 'burning'
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

  return (
    <div
      className="nav-child-panel send-panel burn-panel"
      data-aeon-scope="asset-burn"
      data-aeon-state={stateToAttr(stage)}
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
          <div className="actions send-actions">
            <button type="button" className="btn btn-primary" onClick={onBack}>
              Edit
            </button>
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              Close
            </button>
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
              <div className="actions send-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  aria-busy={busy || undefined}
                  onClick={onConfirm}
                >
                  {busy ? 'Burning…' : 'Confirm'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={onBack}
                >
                  Back
                </button>
              </div>
              {alternativeActionLabel && onAlternativeAction ? (
                <button
                  type="button"
                  className="btn btn-ghost burn-forget"
                  disabled={busy || alternativeActionBusy}
                  aria-busy={alternativeActionBusy || undefined}
                  onClick={onAlternativeAction}
                >
                  {alternativeActionBusy
                    ? 'Forgetting…'
                    : alternativeActionLabel}
                </button>
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
              {amountField}
              {breakdown}
              <p className="burn-note">
                Only eligible physical sats come back as wallet change. The
                asset itself ends here.
              </p>
              <div className="actions send-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!canReview || busy}
                  aria-busy={busy || undefined}
                  onClick={onReview}
                >
                  {busy ? 'Burning…' : 'Review'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={onCancel}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function BurnFungiblePanel({ tokenId }: { tokenId: string }) {
  const [token, setToken] = useState<FungibleToken | null>(() =>
    getFungible(tokenId)
  )
  const [snapshot, event] = useMachine(assetBurnUiMachine)

  useEffect(() => {
    event({ type: 'OPEN' })
  }, [event])

  useEffect(() => {
    const pick = (list: FungibleToken[]) =>
      list.find(
        (t) => t.tokenId === tokenId || t.tokenIds?.includes(tokenId)
      ) ?? null
    const unsubscribe = subscribeFungibles((list) => setToken(pick(list)))
    let cancelled = false
    void listFungibles().then((list) => {
      if (!cancelled) setToken(pick(list))
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [tokenId])

  const typed = snapshot.context.amount

  // Coalesce keystrokes: the preview selects real outputs, so it must not run
  // once per typed digit. 1sat-ft only — never preview a leftover BSV-21 plan.
  useEffect(() => {
    if (!token || token.colourSupply == null || !typed.trim()) return
    let units: string
    try {
      units = parseFungibleSendAmount(typed, token).unitsStr
    } catch {
      event({ type: 'PREVIEW', preview: null })
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void previewFungibleBurn({ tokenId: token.tokenId, amount: units })
        .then((preview) => {
          if (cancelled) return
          event({
            type: 'PREVIEW',
            preview: {
              grossSats: preview.grossAssetSats,
              protocolOutputSats: preview.protocolOutputSats,
              estimatedFeeSats: preview.estimatedFeeSats,
            },
          })
        })
        .catch(() => {
          if (!cancelled) event({ type: 'PREVIEW', preview: null })
        })
    }, 220)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [token, typed, event])

  if (!token) {
    return (
      <EmptyState
        icon={<CollectablesIcon size={28} />}
        title="Token not on this device"
        body="Fungible balances live on the install that received them."
      />
    )
  }

  const held = formatFungibleAmount(token.amt, token.dec)
  const heldUnits = BigInt(token.amt.replace(/\D/g, '') || '0')
  let typedUnits: bigint | null = null
  try {
    typedUnits = parseFungibleSendAmount(typed, token).units
  } catch {
    typedUnits = null
  }
  const multiDeploy = (token.tokenIds?.length ?? 1) > 1
  const refusal =
    token.colourSupply == null
      ? 'This wallet burns 1Sat tokens only. Legacy tips stay read-only.'
      : token.spendKind === 'cosigned'
        ? 'This token requires a cosigner, so it cannot be burned here.'
        : token.spendKind === 'mixed'
          ? 'This balance mixes plain and cosigned outputs — separate them first.'
          : multiDeploy
            ? 'This balance combines several deploy IDs. Burn each deploy separately.'
            : null
  const tokenChange = typedUnits != null && typedUnits < heldUnits
  const preview = snapshot.context.preview
  // A real plan selects real outputs, so it replaces the estimate outright.
  const economics: BurnEconomics = preview
    ? {
        grossAssetSats: preview.grossSats,
        protocolOutputSats: preview.protocolOutputSats,
        recoverableSats: Math.max(
          0,
          preview.grossSats - preview.protocolOutputSats
        ),
        estimatedFeeSats: preview.estimatedFeeSats,
        estimatedPayEffectSats:
          Math.max(0, preview.grossSats - preview.protocolOutputSats) -
          preview.estimatedFeeSats,
      }
    : estimateBurnEconomics({
        inputCount: token.utxoCount,
        protocolOutputCount: tokenChange ? 1 : 0,
        recoveryOutput: true,
        grossAssetSats: token.utxoCount,
      })

  /** Pre-flight the amount while it can still be edited, as Send does. */
  const review = () => {
    playWalletSound('soft')
    try {
      if (refusal) throw new Error(refusal)
      const { units } = parseFungibleSendAmount(typed, token)
      if (units <= 0n) throw new Error('Enter an amount to burn')
      if (units > heldUnits)
        throw new Error(`You only hold ${held} ${token.sym}`)
    } catch (err) {
      event({
        type: 'FAIL',
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    event({ type: 'REVIEW' })
  }

  /**
   * Hand the burn to the wallet and step back to the token page — progress and
   * the settled row belong to Activity, exactly as with a send.
   */
  const confirm = () => {
    let units: string
    try {
      if (token.colourSupply == null) {
        throw new Error('This wallet burns 1Sat tokens only.')
      }
      units = parseFungibleSendAmount(typed, token).unitsStr
    } catch (err) {
      event({
        type: 'FAIL',
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    event({ type: 'CONFIRM' })
    const sym = token.sym
    const label = `${typed.trim()} ${sym}`
    openFungibleDetails(token.tokenId)
    void burnBsv21({ tokenId: token.tokenId, amount: units })
      .then((result) => {
        playWalletSound('success')
        toastSuccess(
          `${sym} burned`,
          `${label} permanently destroyed. ${result.recoveredSatoshis.toLocaleString()} physical sats recovered${
            result.feeSatoshis != null
              ? `; ${result.feeSatoshis.toLocaleString()} sats network fee.`
              : ' before fees.'
          }`
        )
      })
      .catch((err) => {
        playWalletSound('error')
        toastError(
          'Token burn failed',
          err instanceof Error ? err.message : String(err)
        )
      })
  }

  return (
    <BurnShell
      stage={stageOf(snapshot)}
      media={
        <FungibleTokenFace
          tokenId={token.tokenId}
          sym={token.sym}
          iconUrl={token.iconUrl}
          size={48}
        />
      }
      eyebrow="Burn token"
      title={token.sym}
      subtitle={`You hold ${held} ${token.sym}`}
      amountLabel={`${typed.trim() || '0'} ${token.sym}`}
      confirmSubtitle={
        typedUnits != null && typedUnits < heldUnits
          ? `Leaves ${formatFungibleAmount(
              (heldUnits - typedUnits).toString(),
              token.dec
            )} ${token.sym}`
          : `Your whole ${token.sym} balance`
      }
      amountField={
        <div className="field send-amount-field burn-amount-field">
          <label htmlFor="burn-amount">Amount to destroy</label>
          <div className="send-amount-row">
            <input
              id="burn-amount"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              value={typed}
              disabled={refusal != null}
              placeholder={
                token.dec > 0 ? `0.${'0'.repeat(Math.min(token.dec, 4))}` : '0'
              }
              onChange={(e) =>
                event({ type: 'SET_AMOUNT', amount: e.target.value })
              }
            />
            <button
              type="button"
              className="btn btn-ghost"
              disabled={refusal != null}
              onClick={() => event({ type: 'SET_AMOUNT', amount: held })}
            >
              All
            </button>
          </div>
          <p className="field-hint burn-available">
            {held} {token.sym} available
          </p>
        </div>
      }
      economics={economics}
      grossLabel={preview ? 'Asset sats selected' : 'Asset sats available'}
      refusal={refusal}
      error={snapshot.context.error}
      canReview={refusal == null && typed.trim().length > 0}
      onReview={review}
      onConfirm={confirm}
      onBack={() => event({ type: 'BACK' })}
      onCancel={() => openFungibleDetails(token.tokenId)}
    />
  )
}

function BurnCollectablePanel({ outpoint }: { outpoint: string }) {
  const [item, setItem] = useState<Collectable | null>(
    () => getCachedCollectables().find((i) => i.outpoint === outpoint) ?? null
  )
  const [loading, setLoading] = useState(() => item == null)
  const [sending, setSending] = useState(() => isOutpointSending(outpoint))
  const [forgetting, setForgetting] = useState(false)
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
      ? 'This item is mid-send. Wait for it to settle first.'
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
    if (forgetting || sending) return
    event({ type: 'FORGET' })
    setForgetting(true)
    void abandonCollectable(item.outpoint)
      .then(() => {
        playWalletSound('success')
        toastSuccess(
          'Collectable forgotten',
          'Removed from this wallet without broadcasting a burn transaction.'
        )
        clearNavChild()
      })
      .catch((err) => {
        playWalletSound('error')
        toastError(
          'Forget failed',
          err instanceof Error ? err.message : String(err)
        )
      })
      .finally(() => setForgetting(false))
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
      alternativeActionBusy={forgetting}
      alternativeNote="Or remove it from this wallet without spending it. Nothing is broadcast, and the on-chain UTXO remains where it is."
      onAlternativeAction={forget}
    />
  )
}
