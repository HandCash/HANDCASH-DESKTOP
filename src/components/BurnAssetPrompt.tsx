import { useEffect, useState } from 'react'
import { Prompt } from '@aeon-ui/react'
import { formatSecondaryFromSats, getCachedUsdPerBsv, subscribeUsdRate } from '../wallet/fx'
import {
  getDisplayCurrency,
  subscribeDisplayCurrency,
  type DisplayCurrency,
} from '../wallet/displayCurrency'
import { playWalletSound } from '../wallet/soundService'

export type BurnStage = 'editing' | 'confirming' | 'failure'

type Props = {
  stage: BurnStage | null
  assetName: string
  amountLabel: string
  grossSats: number
  grossLabel?: string
  protocolOutputSats: number
  estimatedFeeSats: number
  amountInput?: {
    label: string
    value: string
    suffix?: string
    onChange: (value: string) => void
  }
  /** Held balance, shown under the field the way Send shows Available. */
  availableLabel?: string
  /** Blocks Review while the composed amount is not spendable. */
  canReview?: boolean
  error?: string | null
  onCancel: () => void
  onBack: () => void
  onReview: () => void
  onConfirm: () => void
}

/**
 * Irreversible asset destruction, composed the way a payment is.
 *
 * `editing` chooses the amount and shows the economics; `confirming` restates
 * one fixed amount with no field to retype, which is the only place the destroy
 * button lives. Confirming hands the burn to the wallet and closes — progress
 * and the settled row belong to Activity, as with a send. A refusal comes back
 * as `failure`, where the amount can still be edited.
 *
 * The physical satoshis and the token/item identity stay separate values:
 * burning metadata never creates BSV, and the network fee is paid from managed
 * Pay balance even when asset sats are recovered.
 */
export function BurnAssetPrompt({
  stage,
  assetName,
  amountLabel,
  grossSats,
  grossLabel = 'Asset sats selected',
  protocolOutputSats,
  estimatedFeeSats,
  amountInput,
  availableLabel,
  canReview = true,
  error,
  onCancel,
  onBack,
  onReview,
  onConfirm,
}: Props) {
  const [usdPerBsv, setUsdPerBsv] = useState<number | null>(() => getCachedUsdPerBsv())
  const [currency, setCurrency] = useState<DisplayCurrency>(() => getDisplayCurrency())

  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])
  useEffect(() => subscribeDisplayCurrency(setCurrency), [])

  const isFailure = stage === 'failure'
  useEffect(() => {
    if (!isFailure) return
    playWalletSound('error')
  }, [isFailure])

  const recovered = Math.max(0, grossSats - protocolOutputSats)
  const net = recovered - estimatedFeeSats
  const netSecondary =
    net !== 0 ? formatSecondaryFromSats(Math.abs(net), currency, usdPerBsv) : null

  return (
    <div data-aeon-scope="asset-burn-prompt" data-aeon-state={stage ?? 'closed'}>
      <Prompt.Root
        open={stage != null}
        status={
          stage == null ? 'dismissed' : stage === 'confirming' ? 'confirming' : 'pending'
        }
        onOpenChange={(next) => {
          if (!next) onCancel()
        }}
      >
        <Prompt.Portal>
          <Prompt.Backdrop className="permission-backdrop" />
          <Prompt.Positioner className="permission-positioner">
            <Prompt.Content className="panel modal permission-modal asset-burn-modal">
              {stage === 'failure' ? (
                <>
                  <Prompt.Eyebrow>Nothing was destroyed</Prompt.Eyebrow>
                  <Prompt.Title>Couldn’t burn {assetName}</Prompt.Title>
                  <p className="error asset-burn-error">{error}</p>
                  <Prompt.Actions className="actions connect-actions">
                    <Prompt.Secondary
                      type="button"
                      className="btn btn-ghost"
                      onClick={onCancel}
                    >
                      Close
                    </Prompt.Secondary>
                    <Prompt.Primary type="button" className="btn btn-primary" onClick={onBack}>
                      Edit
                    </Prompt.Primary>
                  </Prompt.Actions>
                </>
              ) : stage === 'confirming' ? (
                <>
                  <Prompt.Eyebrow>You’re burning</Prompt.Eyebrow>
                  <Prompt.Amount className="asset-burn-confirm-amount">{amountLabel}</Prompt.Amount>
                  <Prompt.Title className="asset-burn-target">{assetName}</Prompt.Title>
                  <Prompt.Description className="lede permission-lede-compact">
                    Destroyed on chain for good — no undo, and History backup cannot bring it back.
                  </Prompt.Description>
                  <Prompt.Meta className="permission-meta asset-burn-meta">
                    <div>
                      <dt>Cash recovered</dt>
                      <dd>{recovered.toLocaleString()} sats</dd>
                    </div>
                    <div>
                      <dt>Network fee from Pay</dt>
                      <dd>about {estimatedFeeSats.toLocaleString()} sats</dd>
                    </div>
                    <div>
                      <dt>Effect on Pay</dt>
                      <dd>
                        {net >= 0 ? '+' : '−'}
                        {Math.abs(net).toLocaleString()} sats
                        {netSecondary ? ` · ≈ ${netSecondary}` : ''}
                      </dd>
                    </div>
                  </Prompt.Meta>
                  <Prompt.Actions className="actions connect-actions">
                    <Prompt.Secondary type="button" className="btn btn-ghost" onClick={onBack}>
                      Back
                    </Prompt.Secondary>
                    <Prompt.Primary type="button" className="btn btn-danger" onClick={onConfirm}>
                      Burn {amountLabel}
                    </Prompt.Primary>
                  </Prompt.Actions>
                </>
              ) : (
                <>
                  <Prompt.Eyebrow>Permanent on-chain burn</Prompt.Eyebrow>
                  <Prompt.Title>Burn {assetName}?</Prompt.Title>
                  <Prompt.Description className="lede permission-lede-compact">
                    Choose what to destroy. You’ll confirm the exact amount next.
                  </Prompt.Description>
                  {amountInput ? (
                    <label className="asset-burn-amount">
                      <span>{amountInput.label}</span>
                      <span className="asset-burn-amount-control">
                        <input
                          type="text"
                          inputMode="decimal"
                          autoComplete="off"
                          autoFocus
                          value={amountInput.value}
                          onChange={(event) => amountInput.onChange(event.target.value)}
                        />
                        {amountInput.suffix ? <em>{amountInput.suffix}</em> : null}
                      </span>
                      {availableLabel ? (
                        <p className="asset-burn-available">You hold {availableLabel}</p>
                      ) : null}
                    </label>
                  ) : null}
                  <Prompt.Meta className="permission-meta asset-burn-meta">
                    <div>
                      <dt>{grossLabel}</dt>
                      <dd>{grossSats.toLocaleString()} sats</dd>
                    </div>
                    <div>
                      <dt>Protocol outputs</dt>
                      <dd>{protocolOutputSats.toLocaleString()} sats</dd>
                    </div>
                    <div>
                      <dt>Cash recovered</dt>
                      <dd>{recovered.toLocaleString()} sats</dd>
                    </div>
                    <div>
                      <dt>Network fee from Pay</dt>
                      <dd>about {estimatedFeeSats.toLocaleString()} sats</dd>
                    </div>
                    <div>
                      <dt>Effect on Pay</dt>
                      <dd>
                        {net >= 0 ? '+' : '−'}
                        {Math.abs(net).toLocaleString()} sats
                        {netSecondary ? ` · ≈ ${netSecondary}` : ''}
                      </dd>
                    </div>
                  </Prompt.Meta>
                  <Prompt.Effect>
                    Token units or collectable identity end here. Only eligible physical sats are
                    internalized as normal wallet change.
                  </Prompt.Effect>
                  <Prompt.Actions className="actions connect-actions">
                    <Prompt.Secondary
                      type="button"
                      className="btn btn-ghost"
                      onClick={onCancel}
                    >
                      Keep asset
                    </Prompt.Secondary>
                    <Prompt.Primary
                      type="button"
                      className="btn btn-danger"
                      disabled={!canReview}
                      onClick={onReview}
                    >
                      Review burn
                    </Prompt.Primary>
                  </Prompt.Actions>
                </>
              )}
            </Prompt.Content>
          </Prompt.Positioner>
        </Prompt.Portal>
      </Prompt.Root>
    </div>
  )
}
