import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMachine } from '@xstate/react'
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
import { formatSpendingAuthorizationLabel } from '../wallet/spendingAuthorization'
import type { AutoPayChoice } from './ActionPermissionDialog'
import { PermissionItemPreview } from './PermissionItemPreview'
import { permissionDecisionMachine } from '../machines/permissionDecisionMachine'

export type PermissionDecisionApi = {
  allow: () => void
  deny: () => void
  allowDisabled: boolean
  allowLabel: string
  denyLabel: string
}

type Props = {
  pending: PendingPrompt
  /** True only when this exact prompt was still current and accepted. */
  onAllow: (autoPay?: AutoPayChoice) => boolean
  /** True only when this exact prompt was still current and cancelled. */
  onDeny: () => boolean
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
    pending.title === 'Send token' ||
    pending.title === 'Confirm token send' ||
    pending.title === 'Release token' ||
    pending.title === 'Mint token' ||
    pending.title === 'Mint item'
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
  const [decision, sendDecision] = useMachine(permissionDecisionMachine)
  const decisionCommittedRef = useRef(false)
  const [iconReady, setIconReady] = useState(false)
  const [autoEnabled, setAutoEnabled] = useState(false)
  const [maxUsd, setMaxUsd] = useState(String(DEFAULT_AUTO_PAY_MAX_USD))
  const [windowHours, setWindowHours] = useState(String(DEFAULT_AUTO_PAY_WINDOW_HOURS))
  const inlineActions = actions === 'inline'

  useEffect(() => {
    decisionCommittedRef.current = false
    sendDecision({ type: 'RESET' })
    setIconReady(false)
  }, [pending.id, pending.origin, sendDecision])

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
  const committing = decision.matches('committing')
  const allowDisabled =
    committing || (showAutoPay && autoEnabled && (!maxUsdValid || !hoursValid))

  const runAllow = () => {
    if (decisionCommittedRef.current || !decision.matches('pending')) return
    decisionCommittedRef.current = true
    const accepted =
      pending.kind === 'connect' || !showAutoPay
        ? onAllow()
        : onAllow({
            enabled: autoEnabled,
            maxUsd: maxUsdValid ? parsedMaxUsd : DEFAULT_AUTO_PAY_MAX_USD,
            windowHours: hoursValid ? Math.round(parsedHours) : DEFAULT_AUTO_PAY_WINDOW_HOURS,
          })
    if (accepted) {
      sendDecision({ type: 'APPROVE' })
      return
    }
    // The HTTP caller may have disconnected or timed out while this panel was
    // visible. Do not strand a stale projection in an irreversible busy state.
    decisionCommittedRef.current = false
    sendDecision({ type: 'RESET' })
  }

  const runDeny = () => {
    if (decisionCommittedRef.current || !decision.matches('pending')) return
    decisionCommittedRef.current = true
    if (onDeny()) {
      sendDecision({ type: 'CANCEL' })
      return
    }
    decisionCommittedRef.current = false
    sendDecision({ type: 'RESET' })
  }

  useEffect(() => {
    if (inlineActions || !onDecisionApi) return
    onDecisionApi({
      allow: runAllow,
      deny: runDeny,
      allowDisabled,
      allowLabel: committing ? 'Approving…' : 'Accept',
      denyLabel: 'Cancel',
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
    committing,
    onAllow,
    onDeny,
    onDecisionApi,
    inlineActions,
  ])

  const actionButtons = inlineActions ? (
    <div className="actions connect-actions permission-request-actions">
      <button
        type="button"
        className="btn btn-ghost"
        disabled={committing}
        onClick={runDeny}
      >
        Cancel
      </button>
      <button
        type="button"
        className="btn btn-primary"
        autoFocus
        disabled={allowDisabled}
        onClick={runAllow}
      >
        {committing
          ? 'Approving…'
          : pending.kind === 'connect'
            ? 'Authorize'
            : 'Approve'}
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
          {pending.spendingAuthorization
            ? `${formatSpendingAuthorizationLabel(pending.spendingAuthorization)}. Authorizing enables Auto-pay within that monthly cap. Disconnect anytime in Connected apps.`
            : 'Payments and items still need separate approval. Disconnect anytime in Connected apps.'}
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

      {pending.kind === 'action' &&
      (pending.itemOutpoint || pending.tokenId || pending.itemName) ? (
        <PermissionItemPreview
          outpoint={pending.itemOutpoint}
          tokenId={pending.tokenId}
          itemName={pending.itemName}
          itemImageUrl={pending.itemImageUrl}
          previewKind={pending.previewKind}
        />
      ) : null}

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
              <span className="auto-pay-unit">
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
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </>,
  )
}
