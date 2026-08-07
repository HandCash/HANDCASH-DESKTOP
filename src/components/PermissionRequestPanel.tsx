import { useEffect, useState } from 'react'
import type { PendingPrompt } from '../wallet/permissions'
import { CONNECT_SCOPES, appDisplayName, appHomepage, humanActionCopy } from '../wallet/appIdentity'
import { AppAvatar } from './AppAvatar'
import { ScopeIcon } from './ScopeIcon'
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
import type { AutoPayChoice } from './ActionPermissionDialog'

export type PermissionDecisionApi = {
  allow: () => void
  deny: () => void
  allowDisabled: boolean
  allowLabel: string
  denyLabel: string
}

type Props = {
  pending: PendingPrompt
  onAllow: (autoPay?: AutoPayChoice) => void
  onDeny: () => void
  /** Parent renders Accept/Decline in the bottom nav bar. */
  onDecisionApi: (api: PermissionDecisionApi | null) => void
}

function isBsvPaymentAction(pending: PendingPrompt): boolean {
  if (pending.kind !== 'action') return false
  if (pending.method !== 'createAction' && pending.method !== 'signAction') return false
  if (
    pending.title === 'Send item' ||
    pending.title === 'Confirm item send' ||
    pending.title === 'Release item'
  ) {
    return false
  }
  return true
}

/**
 * Inline permission request for the Activity tab (mobile).
 * Decision buttons live in the wallet nav bar via onDecisionApi.
 */
export function PermissionRequestPanel({ pending, onAllow, onDeny, onDecisionApi }: Props) {
  const [iconReady, setIconReady] = useState(false)
  const [autoEnabled, setAutoEnabled] = useState(false)
  const [maxUsd, setMaxUsd] = useState(String(DEFAULT_AUTO_PAY_MAX_USD))
  const [windowHours, setWindowHours] = useState(String(DEFAULT_AUTO_PAY_WINDOW_HOURS))

  useEffect(() => {
    setIconReady(false)
  }, [pending.id, pending.origin])

  useEffect(() => {
    if (pending.kind !== 'action') return
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
  }, [pending])

  const name = appDisplayName(pending.origin)
  const showAutoPay = isBsvPaymentAction(pending)
  const parsedMaxUsd = Number.parseFloat(maxUsd)
  const parsedHours = Number.parseFloat(windowHours)
  const maxUsdValid = Number.isFinite(parsedMaxUsd) && parsedMaxUsd > 0
  const hoursValid = Number.isFinite(parsedHours) && parsedHours > 0
  const allowDisabled = showAutoPay && autoEnabled && (!maxUsdValid || !hoursValid)

  useEffect(() => {
    const allow = () => {
      if (pending.kind === 'connect' || !showAutoPay) {
        onAllow()
        return
      }
      onAllow({
        enabled: autoEnabled,
        maxUsd: maxUsdValid ? parsedMaxUsd : DEFAULT_AUTO_PAY_MAX_USD,
        windowHours: hoursValid ? Math.round(parsedHours) : DEFAULT_AUTO_PAY_WINDOW_HOURS,
      })
    }
    onDecisionApi({
      allow,
      deny: onDeny,
      allowDisabled,
      allowLabel: pending.kind === 'connect' ? 'Accept' : 'Accept',
      denyLabel: 'Decline',
    })
    return () => onDecisionApi(null)
  }, [
    pending,
    showAutoPay,
    autoEnabled,
    maxUsdValid,
    hoursValid,
    parsedMaxUsd,
    parsedHours,
    allowDisabled,
    onAllow,
    onDeny,
    onDecisionApi,
  ])

  if (pending.kind === 'connect') {
    const home = appHomepage(pending.origin)
    return (
      <div
        className="permission-request-panel"
        data-aeon-scope="connect-permission-inline"
        data-aeon-state={iconReady ? 'pending' : 'loading'}
      >
        <div className="connect-app-hero">
          <AppAvatar
            origin={pending.origin}
            name={name}
            size="lg"
            onReady={() => setIconReady(true)}
          />
          <div>
            <p className="permission-eyebrow">HandCash Connect</p>
            <h2 className="permission-request-title">Connect {name}?</h2>
            <p className="connect-app-host mono">{pending.origin}</p>
          </div>
        </div>

        <p className="lede">
          <strong>{name}</strong> wants to connect to your HandCash wallet.
          {home ? (
            <>
              {' '}
              <a href={home} target="_blank" rel="noreferrer">
                Visit site
              </a>
            </>
          ) : null}
        </p>

        <div className="scope-list" aria-label="Permissions requested">
          <p className="scope-list-label">This app will be able to</p>
          {CONNECT_SCOPES.map((scope) => (
            <div key={scope.id} className="scope-row">
              <span className="scope-icon" aria-hidden>
                <ScopeIcon scopeId={scope.id} size={15} />
              </span>
              <div>
                <strong>{scope.label}</strong>
                <p>{scope.description}</p>
              </div>
            </div>
          ))}
        </div>

        <p className="permission-note">
          BSV payments still need your approval (unless Auto-pay). Viewing or sending collectables
          is approved separately and is never covered by Pay. You can disconnect this app later from
          Connected apps.
        </p>
      </div>
    )
  }

  const copy = humanActionCopy(pending.method, pending.title)
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

  return (
    <div
      className="permission-request-panel"
      data-aeon-scope="action-permission-inline"
      data-aeon-state={iconReady ? 'pending' : 'loading'}
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
          <h2 className="permission-request-title">{pending.title}</h2>
          <p className="lede" style={{ marginBottom: 0 }}>
            <strong className="permission-origin">{name}</strong> {copy.verb}.
          </p>
        </div>
      </div>

      {(amountPrimary || pending.amountLabel) && (
        <div className="action-amount">
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
        Only approve if you trust this request from {name}. Declining cancels it safely.
      </p>
    </div>
  )
}
