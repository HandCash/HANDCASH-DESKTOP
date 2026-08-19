import { useEffect } from 'react'
import { useMachine } from '@xstate/react'
import { ListRow, StatusBanner } from '@aeon-ui/react'
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
import { assetBurnUiMachine } from '../machines/assetBurnUiMachine'
import { burnBsv21, previewBsv21Burn } from '../wallet/burn'
import { estimateBurnEconomics } from '../wallet/burnEconomics'
import { parseFungibleSendAmount } from '../wallet/sendFungible'
import { shortIssuerLabel } from '../wallet/bsv21'
import {
  clearNavChild,
  openPaymentDetails,
  openSendFungible,
} from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import {
  CollectablesIcon,
  CopyIcon,
  MintIcon,
  ReceiveIcon,
  SendIcon,
  WarningIcon,
} from './icons'
import { EmptyState } from './EmptyState'
import { FungibleTokenFace } from './FungibleTokenFace'
import { BurnAssetPrompt } from './BurnAssetPrompt'
import { toastError, toastSuccess } from '../wallet/toast'

type Props = {
  tokenId: string
}

function MetaRow({
  label,
  value,
  copyLabel,
}: {
  label: string
  value: string
  copyLabel?: string
}) {
  return (
    <div className="fungible-detail-row">
      <dt>{label}</dt>
      <dd>
        {copyLabel ? (
          <button
            type="button"
            className="mono collectable-meta-copy"
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
      <ListRow.Leading className="fungible-activity-icon" aria-hidden>
        {failed ? '!' : burned ? (
          <WarningIcon size={14} />
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
  const [burnSnapshot, burnEvent] = useMachine(assetBurnUiMachine)

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

  useEffect(() => {
    if (
      !burnSnapshot.matches('confirming') &&
      !burnSnapshot.matches('failed')
    ) {
      return
    }
    const current = snapshot.context.token
    const raw = burnSnapshot.context.amount
    if (!current || !raw.trim()) return
    let units: string
    try {
      units = parseFungibleSendAmount(raw, current).unitsStr
    } catch {
      burnEvent({ type: 'PREVIEW', preview: null })
      return
    }
    let cancelled = false
    void previewBsv21Burn({ tokenId: current.tokenId, amount: units })
      .then((preview) => {
        if (cancelled) return
        burnEvent({
          type: 'PREVIEW',
          preview: {
            grossSats: preview.grossAssetSats,
            protocolOutputSats: preview.protocolOutputSats,
            estimatedFeeSats: preview.estimatedFeeSats,
          },
        })
      })
      .catch(() => {
        if (!cancelled) burnEvent({ type: 'PREVIEW', preview: null })
      })
    return () => {
      cancelled = true
    }
  }, [
    burnSnapshot.value,
    burnSnapshot.context.amount,
    snapshot.context.token,
    burnEvent,
  ])

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
  const sendBlocked = token.spendKind !== 'plain'
  const issuerLabel =
    token.issuerHandle || (token.issuer ? shortIssuerLabel(token.issuer) : 'Unknown issuer')
  const tokenIds = token.tokenIds?.length ? token.tokenIds : [token.tokenId]
  const burnBlocked = sendBlocked || tokenIds.length > 1
  const spendLabel =
    token.spendKind === 'plain'
      ? 'Wallet controlled'
      : token.spendKind === 'cosigned'
        ? 'Cosigner required'
        : 'Mixed plain and cosigned outputs'
  const burnAmount = burnSnapshot.context.amount || amount
  let burnUnits: bigint | null = null
  try {
    burnUnits = parseFungibleSendAmount(burnAmount, token).units
  } catch {
    burnUnits = null
  }
  const heldUnits = BigInt(token.amt.replace(/\D/g, '') || '0')
  const tokenChange = burnUnits != null && burnUnits < heldUnits
  const fallbackBurnEconomics = estimateBurnEconomics({
    inputCount: token.utxoCount,
    protocolOutputCount: tokenChange ? 2 : 1,
    recoveryOutput: token.utxoCount > (tokenChange ? 2 : 1),
  })
  const burnEconomics = burnSnapshot.context.preview ?? fallbackBurnEconomics
  const pageState = !burnSnapshot.matches('closed')
    ? String(burnSnapshot.value)
    : sendBlocked
      ? 'send-refused'
      : 'ready'
  const confirmTokenBurn = () => {
    if (burnSnapshot.matches('burning')) return
    let units: string
    try {
      units = parseFungibleSendAmount(burnAmount, token).unitsStr
    } catch (err) {
      burnEvent({
        type: 'FAIL',
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    burnEvent({ type: 'CONFIRM' })
    void burnBsv21({ tokenId: token.tokenId, amount: units })
      .then((result) => {
        burnEvent({
          type: 'SUCCESS',
          txid: result.txid,
          recoveredSatoshis: result.recoveredSatoshis,
        })
        toastSuccess(
          `${token.sym} burned`,
          `${burnAmount} permanently destroyed. ${result.recoveredSatoshis.toLocaleString()} physical sats recovered${
            result.feeSatoshis != null
              ? `; ${result.feeSatoshis.toLocaleString()} sats network fee.`
              : ' before fees.'
          }`,
        )
      })
      .catch((err) => {
        const error = err instanceof Error ? err.message : String(err)
        burnEvent({ type: 'FAIL', error })
        toastError('Token burn failed', error)
      })
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
          size={112}
        />
        <div className="fungible-details-heading">
          <span className="fungible-details-eyebrow">BSV-21 token</span>
          <h2>{token.sym}</h2>
          <strong className="fungible-details-balance">{amount}</strong>
          <span className="fungible-details-issuer">{issuerLabel}</span>
        </div>
      </header>

      <MetricStrip.Root density="loose" className="fungible-metrics">
        <MetricStrip.Chip>
          <MetricStrip.Value>{token.dec}</MetricStrip.Value>
          <MetricStrip.Label>Decimals</MetricStrip.Label>
        </MetricStrip.Chip>
        <MetricStrip.Chip>
          <MetricStrip.Value>{token.utxoCount}</MetricStrip.Value>
          <MetricStrip.Label>{token.utxoCount === 1 ? 'Output' : 'Outputs'}</MetricStrip.Label>
        </MetricStrip.Chip>
        <MetricStrip.Chip>
          <MetricStrip.Value>{tokenIds.length}</MetricStrip.Value>
          <MetricStrip.Label>{tokenIds.length === 1 ? 'Deploy' : 'Deploys'}</MetricStrip.Label>
        </MetricStrip.Chip>
      </MetricStrip.Root>

      {sendBlocked ? (
        <StatusBanner.Root tone="warning" status="send-refused" className="fungible-send-notice">
          <StatusBanner.Copy>
            <StatusBanner.Title>Send unavailable</StatusBanner.Title>
            <StatusBanner.Body>{spendLabel}.</StatusBanner.Body>
          </StatusBanner.Copy>
        </StatusBanner.Root>
      ) : null}

      <section className="fungible-details-section" data-aeon-part="metadata">
        <div className="fungible-section-heading">
          <h3>Token details</h3>
          <span>Locally verified wallet metadata</span>
        </div>
        <dl className="fungible-details-meta">
          <MetaRow label="Ticker" value={token.sym} />
          <MetaRow label="Balance" value={amount} copyLabel="token balance" />
          <MetaRow label="Raw units" value={token.amt} copyLabel="raw token units" />
          <MetaRow label="Decimals" value={String(token.dec)} />
          <MetaRow label="Protocol" value="BSV-21 (application/bsv-20)" />
          <MetaRow label="Basket" value="bsv21" />
          <MetaRow label="Spend policy" value={spendLabel} />
          <MetaRow label="Held outputs" value={String(token.utxoCount)} />
          <MetaRow
            label="Representative output"
            value={token.outpoint}
            copyLabel="representative output"
          />
          <MetaRow label="Token ID" value={token.tokenId} copyLabel="token ID" />
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
            <MetaRow label="Icon inscription" value={token.icon} copyLabel="icon inscription" />
          ) : null}
          {token.issuer ? (
            <MetaRow
              label="Issuer"
              value={token.issuerHandle ? `${token.issuerHandle} · ${token.issuer}` : token.issuer}
              copyLabel="issuer identity key"
            />
          ) : (
            <MetaRow label="Issuer" value="Not supplied" />
          )}
          <MetaRow
            label="Issuer attestation"
            value={token.issuerAttested ? 'Sigma address matched (BRC-77)' : 'Not attested'}
          />
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

      <div className="fungible-details-actions" data-aeon-part="actions">
        <button
          type="button"
          className="btn btn-primary btn-icon"
          disabled={sendBlocked}
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
        <button
          type="button"
          className="btn btn-ghost btn-icon asset-burn-trigger"
          disabled={burnBlocked || burnSnapshot.matches('burning')}
          title={
            sendBlocked
              ? `${spendLabel}; burn unavailable`
              : tokenIds.length > 1
                ? 'This balance combines multiple deploy IDs; burn each deploy separately.'
                : `Burn ${token.sym}`
          }
          onClick={() => {
            if (burnBlocked) return
            playWalletSound('soft')
            burnEvent({ type: 'OPEN', amount })
          }}
        >
          <WarningIcon size={14} />
          Burn token
        </button>
        <button
          type="button"
          className="secondary-btn"
          onClick={() => {
            playWalletSound('soft')
            void copyText(token.tokenId, { label: 'token ID' })
          }}
        >
          <CopyIcon size={16} />
          Copy token ID
        </button>
        <button
          type="button"
          className="secondary-btn"
          onClick={() => {
            playWalletSound('soft')
            clearNavChild()
          }}
        >
          Back
        </button>
      </div>
      <BurnAssetPrompt
        open={
          burnSnapshot.matches('confirming') ||
          burnSnapshot.matches('burning') ||
          burnSnapshot.matches('failed')
        }
        assetName={token.sym}
        amountLabel={`${burnAmount || '0'} ${token.sym}`}
        amountInput={{
          label: 'Token amount to burn',
          value: burnAmount,
          suffix: token.sym,
          onChange: (value) => burnEvent({ type: 'SET_AMOUNT', amount: value }),
        }}
        grossSats={
          'grossSats' in burnEconomics
            ? burnEconomics.grossSats
            : burnEconomics.grossAssetSats
        }
        grossLabel={
          burnSnapshot.context.preview
            ? 'Asset sats selected'
            : 'Asset sats available (upper bound)'
        }
        protocolOutputSats={burnEconomics.protocolOutputSats}
        estimatedFeeSats={burnEconomics.estimatedFeeSats}
        busy={burnSnapshot.matches('burning')}
        error={burnSnapshot.context.error}
        onCancel={() => burnEvent({ type: 'CANCEL' })}
        onConfirm={confirmTokenBurn}
      />
    </div>
  )
}
