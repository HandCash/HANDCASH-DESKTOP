import { useEffect, useState } from 'react'
import { useMachine } from '@xstate/react'
import { Prompt, StatusBanner } from '@aeon-ui/react'
import { MetricStrip } from '@aeon-ui/ui'
import { copyText } from '../wallet/clipboard'
import {
  combineToken,
  classifyFungibleEncoding,
  formatFungibleAmount,
  getFungible,
  listFungibles,
  shortIssuerLabel,
  subscribeFungibles,
  tokenMarketPriceHistory,
} from '../wallet/token'
import {
  listRecentActivity,
  subscribeAppActivity,
} from '../wallet/appActivity'
import {
  fungibleDetailsMachine,
  activityForFungible,
} from '../machines/fungibleDetailsMachine'
import { tokenHistory } from '../wallet/itemHistory'
import { AssetHistoryList } from './AssetHistoryList'
import {
  openBurnFungible,
  openSendFungible,
} from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import {
  CollectablesIcon,
  CopyIcon,
  RefreshIcon,
  SendIcon,
  FireIcon,
} from './icons'
import { EmptyState } from './EmptyState'
import { FungibleTokenFace } from './FungibleTokenFace'
import { TokenPriceChart } from './TokenPriceChart'
import {
  formatPrimaryFromSats,
  getCachedUsdPerBsv,
} from '../wallet/fx'
import { getDisplayCurrency } from '../wallet/displayCurrency'
import {
  isOutpointSending,
  inFlightVerb,
  subscribePaymentProgress,
} from '../wallet/paymentProgress'
import { CollectableSendingMark } from './CollectableSendingMark'
import { useDetailActionDock } from './WalletActionDock'

type Props = {
  tokenId: string
}

function MetaRow({
  label,
  value,
  copyLabel,
  muted = false,
}: {
  label: string
  value: string
  /** Present makes the value a copy button; long ids stay on one line. */
  copyLabel?: string
  /** Absent / not-supplied values read as quiet, not as data. */
  muted?: boolean
}) {
  return (
    <div className="fungible-detail-row" data-aeon-state={muted ? 'absent' : 'present'}>
      <dt>{label}</dt>
      <dd>
        {copyLabel ? (
          <button
            type="button"
            className="mono collectable-meta-copy fungible-detail-id"
            title={`Copy ${copyLabel}\n${value}`}
            onClick={() => {
              playWalletSound('soft')
              void copyText(value, { label: copyLabel })
            }}
          >
            {value}
          </button>
        ) : (
          <span>{value}</span>
        )}
      </dd>
    </div>
  )
}

export function FungibleDetailsPanel({ tokenId }: Props) {
  const initialToken = getFungible(tokenId)
  const [snapshot, send] = useMachine(fungibleDetailsMachine, {
    input: {
      token: initialToken,
      activity: activityForFungible(initialToken, listRecentActivity(500)),
    },
  })
  const [combineOpen, setCombineOpen] = useState(false)
  const [combining, setCombining] = useState(false)
  const [sending, setSending] = useState(() => {
    const op = initialToken?.outpoint
    return op ? isOutpointSending(op) : false
  })

  useEffect(() => {
    const sync = () => {
      const token = getFungible(tokenId)
      send({ type: 'LOAD', token, activity: listRecentActivity(500) })
      const op = token?.outpoint
      if (op) setSending(isOutpointSending(op))
    }
    sync()
    const unsubscribeTokens = subscribeFungibles(sync)
    const unsubscribeActivity = subscribeAppActivity(sync)
    const unsubscribeProgress = subscribePaymentProgress(() => {
      const op = getFungible(tokenId)?.outpoint
      if (op) setSending(isOutpointSending(op))
    })
    let cancelled = false
    void listFungibles().then(() => {
      if (!cancelled) sync()
    })
    return () => {
      cancelled = true
      unsubscribeTokens()
      unsubscribeActivity()
      unsubscribeProgress()
    }
  }, [tokenId, send])

  if (snapshot.matches('loading')) {
    return (
      <div
        className="nav-child-panel fungible-details"
        data-aeon-scope="fungible-details"
        data-aeon-state="loading"
        aria-label="Loading token"
        aria-busy="true"
      />
    )
  }

  const token = snapshot.context.token
  if (!token || snapshot.matches('unavailable')) {
    return (
      <EmptyState
        icon={<CollectablesIcon size={28} />}
        title="Token not on this device"
        body="Fungible balances live on the install that received them."
      />
    )
  }

  const amount = formatFungibleAmount(token.amt, token.dec)
  const displayCurrency = getDisplayCurrency()
  const usdPerBsv = getCachedUsdPerBsv()
  const marketListing = token.marketListing
  const priceHistory = tokenMarketPriceHistory(token.tokenId, snapshot.context.activity)
  const encoding = classifyFungibleEncoding(token)
  const isBinary = encoding.kind === 'brc162'
  const isLegacy = encoding.kind === 'legacy-json'
  const isUnknown = encoding.kind === 'unknown'
  const sendBlocked = !isBinary || token.spendKind !== 'plain'
  const canCombine = isBinary && !sendBlocked && token.utxoCount >= 2
  const supplyLabel = isBinary
    ? token.binarySupply === 'locked'
      ? token.maxSupply != null
        ? `BSV-21 · max supply ${token.maxSupply}`
        : 'BSV-21 · supply locked'
      : 'BSV-21 · no supply cap'
    : null
  const issuerLabel = token.issuerHandle
    ? token.issuerHandle
    : token.issuer
      ? shortIssuerLabel(token.issuer)
      : null
  const tokenIds = token.tokenIds?.length ? token.tokenIds : [token.tokenId]
  // Legacy BSV-21 tips are read-only except Burn (cleanup path).
  const burnBlocked =
    isUnknown || (isBinary && token.spendKind !== 'plain') || tokenIds.length > 1
  const spendLabel = isUnknown
    ? 'BSV-21 encoding unverified'
    : isLegacy
      ? 'Legacy BSV-21 — burn only'
    : token.spendKind === 'plain'
      ? 'Wallet controlled'
      : token.spendKind === 'cosigned'
        ? 'Cosigner required'
        : 'Mixed plain and cosigned outputs'
  const burnTitle = burnBlocked
    ? isUnknown
      ? 'Burn unavailable until token encoding is verified'
      : isBinary && token.spendKind !== 'plain'
      ? `${spendLabel}; burn unavailable`
      : tokenIds.length > 1
        ? 'This balance combines multiple deploy IDs; burn each deploy separately.'
        : `Burn ${token.sym}`
    : `Burn ${token.sym}`
  const inFlight = inFlightVerb(token.outpoint)
  const burning = sending && /^burn/i.test(inFlight ?? '')
  const pageState = combining
    ? 'combining'
    : sendBlocked
      ? 'send-refused'
      : 'ready'

  useDetailActionDock({
    ariaLabel: 'Token actions',
    tertiary: {
      label: burning ? 'Burning…' : 'Burn token',
      shortLabel: burning ? 'Burning…' : 'Burn',
      onClick: () => {
        if (burnBlocked || burning) return
        playWalletSound('soft')
        openBurnFungible(token.tokenId)
      },
      disabled: burnBlocked || combining || burning,
      tone: 'danger',
      icon: <FireIcon size={18} />,
      title: burning ? `${inFlight ?? 'Burning'} ${token.sym}` : burnTitle,
    },
    secondary: !isBinary
      ? undefined
      : canCombine
        ? {
            label: 'Combine tips',
            shortLabel: 'Combine',
            onClick: () => {
              playWalletSound('soft')
              setCombineOpen(true)
            },
            disabled: combining,
            icon: <RefreshIcon size={18} />,
            tone: 'secondary',
            title: `${token.utxoCount} tips → 1 · same balance · small network fee`,
          }
        : {
            label: 'Copy origin',
            shortLabel: 'Copy',
            onClick: () => {
              playWalletSound('soft')
              void copyText(token.tokenId, { label: 'origin' })
            },
            icon: <CopyIcon size={18} />,
            tone: 'secondary',
            title: `Copy origin\n${token.tokenId}`,
          },
    primary: isBinary
      ? {
          label: 'Send token',
          shortLabel: 'Send',
          onClick: () => {
            if (sendBlocked) return
            playWalletSound('soft')
            openSendFungible(token.tokenId)
          },
          disabled: sendBlocked || combining,
          tone: 'primary',
          icon: <SendIcon size={18} />,
          title: sendBlocked ? spendLabel : `Send ${token.sym}`,
        }
      : {
          label: 'Copy ID',
          shortLabel: 'Copy',
          onClick: () => {
            playWalletSound('soft')
            void copyText(token.tokenId, { label: 'token ID' })
          },
          icon: <CopyIcon size={18} />,
          tone: 'primary',
          title: `Copy token ID\n${token.tokenId}`,
        },
  })

  const live = token
  async function runCombine() {
    if (!canCombine || combining) return
    setCombining(true)
    playWalletSound('soft')
    try {
      const result = await combineToken({
        tokenId: live.tokenId,
        sym: live.sym,
      })
      setCombineOpen(false)
      toastSuccess(
        'Tips combined',
        `${result.tipsSpent} tips → 1 · balance unchanged`,
      )
      void listFungibles().catch(() => {})
    } catch (err) {
      toastError(
        'Combine failed',
        err instanceof Error ? err.message : String(err),
      )
    } finally {
      setCombining(false)
    }
  }

  return (
    <div
      className="nav-child-panel fungible-details"
      data-aeon-scope="fungible-details"
      data-aeon-state={pageState}
    >
      <header className="fungible-details-hero" data-aeon-part="hero">
        <div className="collectable-media collectable-media-token fungible-details-face">
          <FungibleTokenFace
            tokenId={token.tokenId}
            sym={token.sym}
            iconUrl={token.iconUrl}
            size={72}
          />
          <CollectableSendingMark sending={sending} verb={inFlight ?? 'Sending'} />
        </div>
        <div className="fungible-details-heading">
          <div className="fungible-details-title">
            <h2>{token.sym}</h2>
            {isLegacy ? (
              <span
                className={`fungible-attest fungible-attest-${
                  token.issuerAttested ? 'ok' : 'none'
                }`}
                title={
                  token.issuerAttested
                    ? 'Deploy inscription carries a Sigma signature matching the issuer address (BRC-77)'
                    : 'No signed issuer attestation on the deploy inscription'
                }
              >
                {token.issuerAttested ? 'Attested' : 'Unattested'}
              </span>
            ) : null}
          </div>
          {issuerLabel ? (
            <div className="fungible-details-ids">
              <span className="fungible-details-origin" title={token.issuer || undefined}>
                {issuerLabel}
              </span>
            </div>
          ) : null}
          <strong className="fungible-details-balance">{amount}</strong>
          {marketListing ? (
            <span className="fungible-details-list-price">
              Listed for{' '}
              {formatPrimaryFromSats(marketListing.priceSats, displayCurrency, usdPerBsv)}
            </span>
          ) : null}
          {supplyLabel ? (
            <span className="fungible-details-issuer">{supplyLabel}</span>
          ) : null}
        </div>
      </header>

      <Prompt.Root
        open={combineOpen}
        status={combining ? 'pending' : combineOpen ? 'pending' : 'dismissed'}
        onOpenChange={(open) => {
          if (!open && !combining) setCombineOpen(false)
        }}
      >
        <Prompt.Portal>
          <Prompt.Backdrop className="permission-backdrop" />
          <Prompt.Positioner className="permission-positioner">
            <Prompt.Content className="panel modal permission-modal">
              <Prompt.Title>Combine tips?</Prompt.Title>
              <Prompt.Description>
                {token.utxoCount} tips → 1 tip. Balance stays {amount} {token.sym}.
                Uses a small network fee for dust and the transaction.
              </Prompt.Description>
              <Prompt.Actions className="actions">
                <Prompt.Secondary
                  type="button"
                  className="btn btn-ghost"
                  disabled={combining}
                  onClick={() => {
                    setCombineOpen(false)
                    playWalletSound('soft')
                  }}
                >
                  Cancel
                </Prompt.Secondary>
                <Prompt.Primary
                  type="button"
                  className="btn btn-primary"
                  disabled={combining}
                  onClick={() => void runCombine()}
                >
                  {combining ? 'Combining…' : 'Combine'}
                </Prompt.Primary>
              </Prompt.Actions>
            </Prompt.Content>
          </Prompt.Positioner>
        </Prompt.Portal>
      </Prompt.Root>

      {sendBlocked ? (
        <StatusBanner.Root tone="warning" status="send-refused" className="fungible-send-notice">
          <StatusBanner.Copy>
            <StatusBanner.Title>Send unavailable</StatusBanner.Title>
            <StatusBanner.Body>{spendLabel}.</StatusBanner.Body>
          </StatusBanner.Copy>
        </StatusBanner.Root>
      ) : null}

      <MetricStrip.Root density="loose" className="fungible-metrics">
        <MetricStrip.Chip>
          <MetricStrip.Value>{token.dec}</MetricStrip.Value>
          <MetricStrip.Label>Decimals</MetricStrip.Label>
        </MetricStrip.Chip>
        <MetricStrip.Chip>
          <MetricStrip.Value>{token.utxoCount}</MetricStrip.Value>
          <MetricStrip.Label>
            {token.utxoCount === 1 ? 'Tip' : 'Tips'}
          </MetricStrip.Label>
        </MetricStrip.Chip>
        {isLegacy ? (
          <MetricStrip.Chip>
            <MetricStrip.Value>{tokenIds.length}</MetricStrip.Value>
            <MetricStrip.Label>{tokenIds.length === 1 ? 'Deploy' : 'Deploys'}</MetricStrip.Label>
          </MetricStrip.Chip>
        ) : null}
      </MetricStrip.Root>

      {isBinary ? (
        <section className="fungible-details-section" data-aeon-part="market">
          <div className="fungible-section-heading">
            <h3>Market</h3>
            <span>Local listing history</span>
          </div>
          <TokenPriceChart
            points={priceHistory}
            currency={displayCurrency}
            usdPerBsv={usdPerBsv}
          />
        </section>
      ) : null}

      <section className="fungible-details-section" data-aeon-part="metadata">
        <div className="fungible-section-heading">
          <h3>{isBinary ? 'Origin' : 'Token details'}</h3>
          <span>{isUnknown ? 'Unverified' : isBinary ? 'Same everywhere' : 'Wallet-local'}</span>
        </div>
        <dl className="fungible-details-meta">
          <MetaRow
            label={isBinary ? 'Origin' : 'Token ID'}
            value={token.tokenId}
            copyLabel={isBinary ? 'origin' : 'token ID'}
          />
          <MetaRow label="Raw units" value={token.amt} copyLabel="raw token units" />
          <MetaRow
            label="Protocol"
            value={
              isBinary
                ? 'BSV-21 (BRC-162)'
                : isLegacy
                  ? 'Legacy BSV-21 (burn only)'
                  : 'BSV-21'
            }
          />
          <MetaRow label="Basket" value={'bsv21'} />
          <MetaRow
            label="Spend policy"
            value={isLegacy ? 'Burn cleanup only — sends retired' : spendLabel}
          />
          <MetaRow
            label="Held tip"
            value={token.outpoint}
            copyLabel="held tip"
          />
          {tokenIds.length > 1
            ? tokenIds.map((id, index) => (
                <MetaRow
                  key={id}
                  label={`Deploy ID ${index + 1}`}
                  value={id}
                  copyLabel={`deploy ID ${index + 1}`}
                />
              ))
            : null}
          {token.icon ? (
            <MetaRow label="Icon" value={token.icon} copyLabel="icon inscription" />
          ) : null}
          {token.issuer ? (
            <MetaRow
              label="Issuer"
              value={token.issuerHandle ? `${token.issuerHandle} · ${token.issuer}` : token.issuer}
              copyLabel="issuer identity key"
            />
          ) : null}
          {isLegacy ? (
            <MetaRow
              label="Attestation"
              value={token.issuerAttested ? 'Sigma matched (BRC-77)' : 'None'}
              muted={!token.issuerAttested}
            />
          ) : null}
          {token.cosign?.pubkey ? (
            <MetaRow
              label="Cosigner key"
              value={token.cosign.pubkey}
              copyLabel="cosigner public key"
            />
          ) : null}
          {token.cosign?.endpoint ? (
            <MetaRow
              label="Cosigner endpoint"
              value={token.cosign.endpoint}
              copyLabel="cosigner endpoint"
            />
          ) : null}
          {token.cosign?.feeAddress ? (
            <MetaRow
              label="Cosigner fee address"
              value={token.cosign.feeAddress}
              copyLabel="cosigner fee address"
            />
          ) : null}
        </dl>
      </section>

      {snapshot.context.activity.length > 0 ? (
        <AssetHistoryList events={tokenHistory(token, snapshot.context.activity)} />
      ) : (
        <p className="fungible-activity-empty">No local activity for this token yet.</p>
      )}
    </div>
  )
}
