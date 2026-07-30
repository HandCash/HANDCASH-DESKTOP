import { useEffect, useState } from 'react'
import { stateToAttr } from '@aeon-ui/core'
import type { PendingAction } from '../wallet/permissions'
import { appDisplayName, humanActionCopy } from '../wallet/appIdentity'
import { AppAvatar } from './AppAvatar'
import { ModalPortal } from './ModalPortal'
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

function ActionPermissionBody({
  pending,
  onAllow,
  onDeny,
}: {
  pending: PendingAction
  onAllow: (autoPay?: AutoPayChoice) => void
  onDeny: () => void
}) {
  const [iconReady, setIconReady] = useState(false)
  const [autoEnabled, setAutoEnabled] = useState(false)
  const [maxUsd, setMaxUsd] = useState(String(DEFAULT_AUTO_PAY_MAX_USD))
  const [windowHours, setWindowHours] = useState(String(DEFAULT_AUTO_PAY_WINDOW_HOURS))

  useEffect(() => {
    setIconReady(false)
  }, [pending.id, pending.origin])

  useEffect(() => {
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
  }, [pending.id, pending.origin])

  const name = appDisplayName(pending.origin)
  const copy = humanActionCopy(pending.method)
  const usdPerBsv = getCachedUsdPerBsv()
  const currency = getDisplayCurrency()
  const amountPrimary =
    pending.amountSats != null && pending.amountSats > 0
      ? formatPrimaryFromSats(pending.amountSats, currency, usdPerBsv)
      : null
  const amountSecondary =
    pending.amountSats != null && pending.amountSats > 0
      ? formatSecondaryFromSats(pending.amountSats, currency, usdPerBsv)
      : null
  const showAutoPay = isPaymentAction(pending.method)

  const parsedMaxUsd = Number.parseFloat(maxUsd)
  const parsedHours = Number.parseFloat(windowHours)
  const maxUsdValid = Number.isFinite(parsedMaxUsd) && parsedMaxUsd > 0
  const hoursValid = Number.isFinite(parsedHours) && parsedHours > 0

  return (
    <div
      className="panel modal permission-modal action-permission-modal"
      data-aeon-part="content"
      data-aeon-state={iconReady ? undefined : 'loading'}
      role="dialog"
      aria-modal="true"
      aria-labelledby="action-permission-title"
    >
      <div className="connect-app-hero">
        <AppAvatar
          origin={pending.origin}
          name={name}
          size="lg"
          onReady={() => setIconReady(true)}
        />
        <div>
          <p className="permission-eyebrow">{copy.eyebrow}</p>
          <h2 id="action-permission-title">{pending.title}</h2>
          <p className="lede" style={{ marginBottom: 0 }}>
            <strong className="permission-origin">{name}</strong> {copy.verb}.
          </p>
        </div>
      </div>

      {(amountPrimary || pending.amountLabel) && (
        <div className="action-amount" data-aeon-part="amount">
          <span>Amount</span>
          <strong>
            {amountPrimary && amountPrimary !== '—' ? amountPrimary : pending.amountLabel}
          </strong>
          {amountSecondary && amountPrimary && amountPrimary !== '—' ? (
            <em className="action-amount-bsv">{amountSecondary}</em>
          ) : null}
        </div>
      )}

      <dl className="permission-meta">
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
      </dl>

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

      <div className="actions connect-actions">
        <button className="btn btn-ghost" type="button" onClick={onDeny}>
          Deny
        </button>
        <button
          className="btn btn-primary"
          type="button"
          autoFocus
          disabled={autoEnabled && (!maxUsdValid || !hoursValid)}
          onClick={() => {
            if (!showAutoPay) {
              onAllow()
              return
            }
            onAllow({
              enabled: autoEnabled,
              maxUsd: maxUsdValid ? parsedMaxUsd : DEFAULT_AUTO_PAY_MAX_USD,
              windowHours: hoursValid
                ? Math.round(parsedHours)
                : DEFAULT_AUTO_PAY_WINDOW_HOURS,
            })
          }}
        >
          Approve
        </button>
      </div>
    </div>
  )
}

export function ActionPermissionDialog({ pending, onAllow, onDeny }: Props) {
  if (!pending) return null

  return (
    <ModalPortal>
      <div
        className="modal-backdrop permission-backdrop"
        data-aeon-scope="dialog"
        data-aeon-state={stateToAttr('pending')}
        role="presentation"
      >
        <ActionPermissionBody pending={pending} onAllow={onAllow} onDeny={onDeny} />
      </div>
    </ModalPortal>
  )
}
