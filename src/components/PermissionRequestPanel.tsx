import { useEffect, useState, type ReactNode } from 'react'
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
  /**
   * Mobile Activity tab: parent renders Accept/Decline in the bottom nav bar.
   * Omit (or pass null handlers via `actions="inline"`) for desktop side-column.
   */
  onDecisionApi?: (api: PermissionDecisionApi | null) => void
  /** When `inline`, render Deny/Approve in the panel (desktop right column). */
  actions?: 'nav' | 'inline'
}

function isBsvPaymentAction(pending: PendingPrompt): boolean {
  if (pending.kind !== 'action') return false
  if (pending.method !== 'createAction' && pending.method !== 'signAction') return false
  if (
    pending.title === 'Send item' ||
    pending.title === 'Confirm item send' ||
    pending.title === 'Release item' ||
    pending.title === 'Mint token'
  ) {
    return false
  }
  return true
}

/**
 * Inline permission request — Activity tab (mobile, actions in nav) or
 * dashboard right column (desktop, actions in panel).
 */
export function PermissionRequestPanel({
  pending,
  onAllow,
  onDeny,
  onDecisionApi,
  actions = 'nav',
}: Props) {
  const [iconReady, setIconReady] = useState(false)
  const [autoEnabled, setAutoEnabled] = useState(false)
  const [maxUsd, setMaxUsd] = useState(String(DEFAULT_AUTO_PAY_MAX_USD))
  const [windowHours, setWindowHours] = useState(String(DEFAULT_AUTO_PAY_WINDOW_HOURS))
  const inlineActions = actions === 'inline'

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

  const runAllow = () => {
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

  useEffect(() => {
    if (inlineActions || !onDecisionApi) return
    onDecisionApi({
      allow: runAllow,
      deny: onDeny,
      allowDisabled,
      allowLabel: 'Accept',
      denyLabel: 'Decline',
    })
    return () => onDecisionApi(null)
    // runAllow closes over current allow inputs; deps below keep the nav API fresh.
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
    inlineActions,
  ])

  const actionButtons = inlineActions ? (
    <div className="actions connect-actions permission-request-actions">
      <button type="button" className="btn btn-ghost" onClick={onDeny}>
        Deny
      </button>
      <button
        type="button"
        className="btn btn-primary"
        autoFocus
        disabled={allowDisabled}
        onClick={runAllow}
      >
        {pending.kind === 'connect' ? 'Authorize' : 'Approve'}
      </button>
    </div>
  ) : null

  const wrap = (scope: string, body: ReactNode) => (
    <div
      className={
        inlineActions
          ? 'permission-request-panel permission-request-panel--column'
          : 'permission-request-panel'
      }
      data-aeon-scope={scope}
      data-aeon-state={iconReady ? 'pending' : 'loading'}
    >
      {inlineActions ? <div className="permission-request-scroll">{body}</div> : body}
      {actionButtons}
    </div>
  )

  if (pending.kind === 'connect') {
    const home = appHomepage(pending.origin)
    return wrap(
      'connect-permission-inline',
      <>
        <div className="connect-app-hero">
          <AppAvatar
            origin={pending.origin}
            name={name}
            size="md"
            onReady={() => setIconReady(true)}
          />
          <div>
            <p className="permission-eyebrow">Connect</p>
            <h2 className="permission-request-title">{name}</h2>
            <p className="connect-app-host mono">{pending.origin}</p>
          </div>
        </div>

        <p className="lede permission-lede-compact">
          Wants to connect to your wallet
          {home ? (
            <>
              {' · '}
              <a href={home} target="_blank" rel="noreferrer">
                Visit site
              </a>
            </>
          ) : null}
        </p>

        <div className="scope-list scope-list-compact" aria-label="Permissions requested">
          {CONNECT_SCOPES.map((scope) => (
            <div key={scope.id} className="scope-row scope-row-compact">
              <span className="scope-icon" aria-hidden>
                <ScopeIcon scopeId={scope.id} size={14} />
              </span>
              <strong>{scope.label}</strong>
            </div>
          ))}
        </div>

        <p className="permission-note">
          Payments and items still need separate approval. Disconnect anytime in Connected
          apps.
        </p>
      </>,
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

  return wrap(
    'action-permission-inline',
    <>
      <div className="connect-app-hero">
        <AppAvatar
          origin={pending.origin}
          name={name}
          size="md"
          onReady={() => setIconReady(true)}
        />
        <div>
          <p className="permission-eyebrow">{copy.eyebrow}</p>
          <h2 className="permission-request-title">{pending.title}</h2>
          <p className="lede permission-lede-compact" style={{ marginBottom: 0 }}>
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
        {pending.details.slice(0, pending.title === 'Mint token' ? 4 : 2).map((line) => (
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
              Auto-pay from <strong>{name}</strong>
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
    </>,
  )
}
