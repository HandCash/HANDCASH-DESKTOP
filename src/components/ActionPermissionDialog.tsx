import { useEffect, useRef, useState } from 'react'
import { Prompt } from '@aeon-ui/react'
import type { PendingAction } from '../wallet/permissions'
import { appDisplayName, humanActionCopy } from '../wallet/appIdentity'
import { AppAvatar } from './AppAvatar'
import {
  formatPrimaryFromSats,
  formatSecondaryFromSats,
  getCachedUsdPerBsv,
} from '../wallet/fx'
import { getDisplayCurrency } from '../wallet/displayCurrency'
import {
  DEFAULT_AUTO_PAY_MAX_USD,
  DEFAULT_AUTO_PAY_WINDOW_HOURS,
  getAutoPaySettings,
  type AutoPaySettings,
} from '../wallet/autoPay'

export type AutoPayChoice = {
  enabled: boolean
  maxUsd: number
  windowHours: number
}

type Props = {
  pending: PendingAction | null
  onAllow: (autoPay?: AutoPayChoice) => void
  onDeny: () => void
}

function isPaymentAction(method: string): boolean {
  return method === 'createAction' || method === 'signAction'
}

/**
 * Chart projection: action permission prompt open ↔ pending request.
 * Uses Aeon Prompt Amount/Meta/Actions — same compound family as update restart.
 */
export function ActionPermissionDialog({ pending, onAllow, onDeny }: Props) {
  const [iconReady, setIconReady] = useState(false)
  const [autoEnabled, setAutoEnabled] = useState(false)
  const [maxUsd, setMaxUsd] = useState(String(DEFAULT_AUTO_PAY_MAX_USD))
  const [windowHours, setWindowHours] = useState(String(DEFAULT_AUTO_PAY_WINDOW_HOURS))
  const skipDenyRef = useRef(false)
  const open = Boolean(pending)

  useEffect(() => {
    setIconReady(false)
  }, [pending?.id, pending?.origin])

  useEffect(() => {
    if (!pending) return
    const existing: AutoPaySettings | null = getAutoPaySettings(pending.origin)
    if (existing?.enabled) {
      setAutoEnabled(true)
      setMaxUsd(String(existing.maxUsd))
      setWindowHours(String(existing.windowHours))
    } else {
      setAutoEnabled(false)
      setMaxUsd(String(DEFAULT_AUTO_PAY_MAX_USD))
      setWindowHours(String(DEFAULT_AUTO_PAY_WINDOW_HOURS))
    }
  }, [pending?.id, pending?.origin])

  const name = pending ? appDisplayName(pending.origin) : ''
  const copy = pending ? humanActionCopy(pending.method) : { eyebrow: '', verb: '' }
  const usdPerBsv = getCachedUsdPerBsv()
  const currency = getDisplayCurrency()
  const amountPrimary =
    pending?.amountSats != null && pending.amountSats > 0
      ? formatPrimaryFromSats(pending.amountSats, currency, usdPerBsv)
      : null
  const amountSecondary =
    pending?.amountSats != null && pending.amountSats > 0
      ? formatSecondaryFromSats(pending.amountSats, currency, usdPerBsv)
      : null
  const showAutoPay = pending ? isPaymentAction(pending.method) : false

  const parsedMaxUsd = Number.parseFloat(maxUsd)
  const parsedHours = Number.parseFloat(windowHours)
  const maxUsdValid = Number.isFinite(parsedMaxUsd) && parsedMaxUsd > 0
  const hoursValid = Number.isFinite(parsedHours) && parsedHours > 0

  const allow = () => {
    skipDenyRef.current = true
    if (!pending) return
    if (!showAutoPay) {
      onAllow()
      return
    }
    onAllow({
      enabled: autoEnabled,
      maxUsd: maxUsdValid ? parsedMaxUsd : DEFAULT_AUTO_PAY_MAX_USD,
      windowHours: hoursValid ? Math.round(parsedHours) : DEFAULT_AUTO_PAY_WINDOW_HOURS,
    })
  }

  return (
    <div
      data-aeon-scope="action-permission"
      data-aeon-state={open ? (iconReady ? 'pending' : 'loading') : 'idle'}
    >
      <Prompt.Root
        open={open}
        status={open ? 'pending' : 'dismissed'}
        onOpenChange={(next) => {
          if (next) return
          if (skipDenyRef.current) {
            skipDenyRef.current = false
            return
          }
          if (pending) onDeny()
        }}
      >
        <Prompt.Portal>
          <Prompt.Backdrop className="permission-backdrop" />
          <Prompt.Positioner className="permission-positioner">
            {pending ? (
              <Prompt.Content
                className="panel modal permission-modal action-permission-modal"
                data-aeon-state={iconReady ? 'ready' : 'loading'}
              >
                <div className="connect-app-hero">
                  <AppAvatar
                    origin={pending.origin}
                    name={name}
                    size="lg"
                    onReady={() => setIconReady(true)}
                  />
                  <div>
                    <Prompt.Eyebrow className="permission-eyebrow">{copy.eyebrow}</Prompt.Eyebrow>
                    <Prompt.Title>{pending.title}</Prompt.Title>
                    <Prompt.Description className="lede" style={{ marginBottom: 0 }}>
                      <strong className="permission-origin">{name}</strong> {copy.verb}.
                    </Prompt.Description>
                  </div>
                </div>

                {(amountPrimary || pending.amountLabel) && (
                  <Prompt.Amount className="action-amount">
                    <span>Amount</span>
                    <strong>
                      {amountPrimary && amountPrimary !== '—'
                        ? amountPrimary
                        : pending.amountLabel}
                    </strong>
                    {amountSecondary && amountPrimary && amountPrimary !== '—' ? (
                      <em className="action-amount-bsv">{amountSecondary}</em>
                    ) : null}
                  </Prompt.Amount>
                )}

                <Prompt.Meta className="permission-meta">
                  <div>
                    <dt>What for</dt>
                    <dd>{pending.summary}</dd>
                  </div>
                  {pending.details.map((line) => (
                    <div key={line}>
                      <dt>Detail</dt>
                      <dd>{line}</dd>
                    </div>
                  ))}
                </Prompt.Meta>

                {showAutoPay ? (
                  <div className="auto-pay" data-aeon-part="auto-pay">
                    <label className="auto-pay-toggle">
                      <input
                        type="checkbox"
                        checked={autoEnabled}
                        onChange={(e) => setAutoEnabled(e.target.checked)}
                      />
                      <span>
                        Automatically process payments from <strong>{name}</strong>
                      </span>
                    </label>

                    {autoEnabled ? (
                      <div className="auto-pay-params" role="group" aria-label="Auto-pay limits">
                        <label className="auto-pay-field">
                          <span className="auto-pay-prefix">$</span>
                          <input
                            type="number"
                            min="0.01"
                            step="0.01"
                            inputMode="decimal"
                            value={maxUsd}
                            onChange={(e) => setMaxUsd(e.target.value)}
                            aria-label="Maximum dollars"
                          />
                        </label>
                        <span className="auto-pay-sep">every</span>
                        <label className="auto-pay-field auto-pay-field-hours">
                          <input
                            type="number"
                            min="1"
                            step="1"
                            inputMode="numeric"
                            value={windowHours}
                            onChange={(e) => setWindowHours(e.target.value)}
                            aria-label="Hours"
                          />
                        </label>
                        <span className="auto-pay-sep">hours</span>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <p className="permission-note">
                  Only approve if you trust this request from {name}. Denying cancels it safely.
                </p>

                <Prompt.Actions className="actions connect-actions">
                  <Prompt.Secondary className="btn btn-ghost" onClick={onDeny}>
                    Deny
                  </Prompt.Secondary>
                  <Prompt.Primary
                    className="btn btn-primary"
                    autoFocus
                    disabled={autoEnabled && (!maxUsdValid || !hoursValid)}
                    onClick={allow}
                  >
                    Approve
                  </Prompt.Primary>
                </Prompt.Actions>
              </Prompt.Content>
            ) : null}
          </Prompt.Positioner>
        </Prompt.Portal>
      </Prompt.Root>
    </div>
  )
}
