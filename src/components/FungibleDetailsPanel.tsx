import { useEffect, useState } from 'react'
import { useMachine } from '@xstate/react'
import { ListRow, Prompt, StatusBanner } from '@aeon-ui/react'
import { MetricStrip } from '@aeon-ui/ui'
import { copyText } from '../wallet/clipboard'
import {
  formatFungibleAmount,
  getFungible,
  listFungibles,
  subscribeFungibles,
} from '../wallet/fungibles'
import {
  activityEntryTitle,
  activityFailureLabel,
  activityTokenAmountDisplay,
  isFailedActivity,
  isBurnActivity,
  isMintTokenActivity,
  isPendingActivity,
  listRecentActivity,
  subscribeAppActivity,
  type ActivityEntry,
} from '../wallet/appActivity'
import {
  fungibleDetailsMachine,
  activityForFungible,
} from '../machines/fungibleDetailsMachine'
import { shortIssuerLabel } from '../wallet/bsv21'
import {
  openBurnFungible,
  openPaymentDetails,
  openSendFungible,
} from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { combineColourTips } from '../wallet/sendColourCoins'
import { toastError, toastSuccess } from '../wallet/toast'
import {
  CollectablesIcon,
  CopyIcon,
  MintIcon,
  ReceiveIcon,
  RefreshIcon,
  SendIcon,
  FireIcon,
  WarningIcon,
} from './icons'
import { EmptyState } from './EmptyState'
import { FungibleTokenFace } from './FungibleTokenFace'
import { TokenPriceChart } from './TokenPriceChart'
import {
  formatPrimaryFromSats,
  getCachedUsdPerBsv,
} from '../wallet/fx'
import { getDisplayCurrency } from '../wallet/displayCurrency'
import { tokenMarketPriceHistory } from '../wallet/tokenMarketView'

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

function formatActivityWhen(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function TokenActivityRow({ entry }: { entry: ActivityEntry }) {
  const failed = isFailedActivity(entry)
  const pending = isPendingActivity(entry)
  const minted = isMintTokenActivity(entry)
  const burned = isBurnActivity(entry)
  const spent = entry.kind === 'spent'
  const burnStatus =
    burned && entry.burn?.recoveredSatoshis != null
      ? `${entry.burn.recoveredSatoshis.toLocaleString()} sats recovered${
          entry.burn.feeSatoshis != null
            ? ` · ${entry.burn.feeSatoshis.toLocaleString()} fee`
            : ''
        }`
      : null
  const status = failed
    ? (activityFailureLabel(entry) ?? 'Failed transaction')
    : pending
      ? burned
        ? 'Burning…'
        : spent
        ? 'Sending…'
        : 'Verifying…'
      : burnStatus ?? formatActivityWhen(entry.at)

  return (
    <ListRow.Root
      as="button"
      type="button"
      className="fungible-activity-row"
      data-aeon-state={failed ? 'failed' : pending ? 'pending' : 'complete'}
      onClick={() => {
        playWalletSound('soft')
        openPaymentDetails(entry.id)
      }}
    >
      <ListRow.Leading
        className={`fungible-activity-icon${burned ? ' is-burn' : ''}`}
        aria-hidden
      >
        {failed ? '!' : burned ? (
          <FireIcon size={14} />
        ) : minted ? (
          <MintIcon size={15} />
        ) : spent ? (
          <SendIcon size={14} />
        ) : (
          <ReceiveIcon size={16} />
        )}
      </ListRow.Leading>
      <span className="fungible-activity-copy">
        <ListRow.Label>{activityEntryTitle(entry)}</ListRow.Label>
        <ListRow.Description title={status}>{status}</ListRow.Description>
      </span>
      <ListRow.Trailing className="fungible-activity-amount">
        {failed ? 'Failed' : activityTokenAmountDisplay(entry)}
      </ListRow.Trailing>
    </ListRow.Root>
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

  useEffect(() => {
    const sync = () => {
      const token = getFungible(tokenId)
      send({ type: 'LOAD', token, activity: listRecentActivity(500) })
    }
    sync()
    const unsubscribeTokens = subscribeFungibles(sync)
    const unsubscribeActivity = subscribeAppActivity(() => {
      send({ type: 'ACTIVITY_SYNCED', activity: listRecentActivity(500) })
    })
    let cancelled = false
    void listFungibles().then(() => {
      if (!cancelled) sync()
    })
    return () => {
      cancelled = true
      unsubscribeTokens()
      unsubscribeActivity()
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
  const isColour = Boolean(token.colourSupply)
  const sendBlocked = !isColour || token.spendKind !== 'plain'
  const canCombine = isColour && !sendBlocked && token.utxoCount >= 2
  const supplyLabel = isColour
    ? token.colourSupply === 'locked'
      ? token.colourMaxSupply != null
        ? `BSV-21 · max supply ${token.colourMaxSupply}`
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
    (isColour && token.spendKind !== 'plain') || tokenIds.length > 1
  const spendLabel = !isColour
    ? 'Legacy BSV-21 — burn only'
    : token.spendKind === 'plain'
      ? 'Wallet controlled'
      : token.spendKind === 'cosigned'
        ? 'Cosigner required'
        : 'Mixed plain and cosigned outputs'
  const burnTitle = burnBlocked
    ? isColour && token.spendKind !== 'plain'
      ? `${spendLabel}; burn unavailable`
      : tokenIds.length > 1
        ? 'This balance combines multiple deploy IDs; burn each deploy separately.'
        : `Burn ${token.sym}`
    : `Burn ${token.sym}`
  const pageState = combining
    ? 'combining'
    : sendBlocked
      ? 'send-refused'
      : 'ready'

  const live = token
  async function runCombine() {
    if (!canCombine || combining) return
    setCombining(true)
    playWalletSound('soft')
    try {
      const result = await combineColourTips({
        origin: live.tokenId,
        sym: live.sym,
        supply: live.colourSupply,
        maxSupply: live.colourMaxSupply ?? null,
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
        <FungibleTokenFace
          tokenId={token.tokenId}
          sym={token.sym}
          iconUrl={token.iconUrl}
          size={72}
        />
        <div className="fungible-details-heading">
          <div className="fungible-details-title">
            <h2>{token.sym}</h2>
            {!isColour ? (
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

      <div className="fungible-details-actions" data-aeon-part="actions">
        {isColour ? (
          <button
            type="button"
            className="btn btn-primary btn-icon"
            disabled={sendBlocked || combining}
            title={sendBlocked ? spendLabel : `Send ${token.sym}`}
            onClick={() => {
              if (sendBlocked) return
              playWalletSound('soft')
              openSendFungible(token.tokenId)
            }}
          >
            <SendIcon size={14} />
            Send token
          </button>
        ) : null}
        {canCombine ? (
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            disabled={combining}
            title={`${token.utxoCount} tips → 1 · same balance · small network fee`}
            onClick={() => {
              playWalletSound('soft')
              setCombineOpen(true)
            }}
          >
            <RefreshIcon size={14} />
            Combine tips
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          title={isColour ? `Copy origin\n${token.tokenId}` : `Copy token ID\n${token.tokenId}`}
          onClick={() => {
            playWalletSound('soft')
            void copyText(token.tokenId, { label: isColour ? 'origin' : 'token ID' })
          }}
        >
          <CopyIcon size={14} />
          {isColour ? 'Copy origin' : 'Copy ID'}
        </button>
        {/* Destructive action is always last, on tokens and on items. */}
        <button
          type="button"
          className={
            isColour
              ? 'btn btn-ghost btn-icon asset-burn-trigger asset-burn-last'
              : 'btn btn-primary btn-icon asset-burn-trigger asset-burn-last'
          }
          disabled={burnBlocked || combining}
          title={burnTitle}
          onClick={() => {
            if (burnBlocked) return
            playWalletSound('soft')
            openBurnFungible(token.tokenId)
          }}
        >
          <WarningIcon size={14} />
          Burn token
        </button>
      </div>

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
        {!isColour ? (
          <MetricStrip.Chip>
            <MetricStrip.Value>{tokenIds.length}</MetricStrip.Value>
            <MetricStrip.Label>{tokenIds.length === 1 ? 'Deploy' : 'Deploys'}</MetricStrip.Label>
          </MetricStrip.Chip>
        ) : null}
      </MetricStrip.Root>

      {isColour ? (
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
          <h3>{isColour ? 'Origin' : 'Token details'}</h3>
          <span>{isColour ? 'Same everywhere' : 'Wallet-local'}</span>
        </div>
        <dl className="fungible-details-meta">
          <MetaRow
            label={isColour ? 'Origin' : 'Token ID'}
            value={token.tokenId}
            copyLabel={isColour ? 'origin' : 'token ID'}
          />
          <MetaRow label="Raw units" value={token.amt} copyLabel="raw token units" />
          <MetaRow
            label="Protocol"
            value={isColour ? 'BSV-21 (BRC-162)' : 'Legacy BSV-21 (burn only)'}
          />
          <MetaRow label="Basket" value={'bsv21'} />
          <MetaRow
            label="Spend policy"
            value={isColour ? spendLabel : 'Burn cleanup only — sends retired'}
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
          {!isColour ? (
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

      <section className="fungible-details-section" data-aeon-part="activity">
        <div className="fungible-section-heading">
          <h3>Token activity</h3>
          <span>{snapshot.context.activity.length} local transactions</span>
        </div>
        {snapshot.context.activity.length > 0 ? (
          <div className="fungible-activity-list">
            {snapshot.context.activity.map((entry) => (
              <TokenActivityRow key={entry.id} entry={entry} />
            ))}
          </div>
        ) : (
          <p className="fungible-activity-empty">No local activity for this token yet.</p>
        )}
      </section>
    </div>
  )
}
