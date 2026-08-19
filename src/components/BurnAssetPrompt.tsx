import { Prompt } from '@aeon-ui/react'

type Props = {
  open: boolean
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
  busy?: boolean
  error?: string | null
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Irreversible asset-destruction confirmation.
 *
 * The physical satoshis and token/item identity are deliberately shown as
 * separate values: burning metadata never creates BSV, and the network fee is
 * paid from managed Pay balance even when one or more asset sats are recovered.
 */
export function BurnAssetPrompt({
  open,
  assetName,
  amountLabel,
  grossSats,
  grossLabel = 'Asset sats selected',
  protocolOutputSats,
  estimatedFeeSats,
  amountInput,
  busy = false,
  error,
  onCancel,
  onConfirm,
}: Props) {
  const recovered = Math.max(0, grossSats - protocolOutputSats)
  const net = recovered - estimatedFeeSats

  return (
    <div data-aeon-scope="asset-burn-prompt" data-aeon-state={busy ? 'burning' : 'confirm'}>
      <Prompt.Root
        open={open}
        status={open ? 'pending' : 'dismissed'}
        onOpenChange={(next) => {
          if (!next && !busy) onCancel()
        }}
      >
        <Prompt.Portal>
          <Prompt.Backdrop className="permission-backdrop" />
          <Prompt.Positioner className="permission-positioner">
            <Prompt.Content className="panel modal permission-modal asset-burn-modal">
              <Prompt.Eyebrow>Permanent on-chain burn</Prompt.Eyebrow>
              <Prompt.Title>Burn {assetName}?</Prompt.Title>
              <Prompt.Description className="lede permission-lede-compact">
                This permanently destroys <strong>{amountLabel}</strong>. It cannot be undone or
                restored from History backup.
              </Prompt.Description>
              {amountInput ? (
                <label className="asset-burn-amount">
                  <span>{amountInput.label}</span>
                  <span className="asset-burn-amount-control">
                    <input
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={amountInput.value}
                      disabled={busy}
                      onChange={(event) => amountInput.onChange(event.target.value)}
                    />
                    {amountInput.suffix ? <em>{amountInput.suffix}</em> : null}
                  </span>
                </label>
              ) : null}
              <Prompt.Meta className="permission-meta">
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
                  <dt>Estimated network fee</dt>
                  <dd>about {estimatedFeeSats.toLocaleString()} sats from Pay</dd>
                </div>
                <div>
                  <dt>Estimated Pay effect</dt>
                  <dd>{net >= 0 ? '+' : '−'}{Math.abs(net).toLocaleString()} sats</dd>
                </div>
              </Prompt.Meta>
              {error ? <p className="field-error">{error}</p> : null}
              <Prompt.Effect>
                Token units or collectable identity end here. Only eligible physical sats are
                internalized as normal wallet change.
              </Prompt.Effect>
              <Prompt.Actions className="actions connect-actions">
                <Prompt.Secondary
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={onCancel}
                >
                  Keep asset
                </Prompt.Secondary>
                <Prompt.Primary
                  type="button"
                  className="btn btn-danger"
                  disabled={busy}
                  onClick={onConfirm}
                >
                  {busy ? 'Burning…' : `Burn ${amountLabel}`}
                </Prompt.Primary>
              </Prompt.Actions>
            </Prompt.Content>
          </Prompt.Positioner>
        </Prompt.Portal>
      </Prompt.Root>
    </div>
  )
}
