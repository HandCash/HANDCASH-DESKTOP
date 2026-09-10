import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMachine } from '@xstate/react'
import {
  acceptsIncomingFunds,
  setAcceptIncomingFunds,
  type PendingPrompt,
} from '../wallet/permissions'
import { appDisplayName, appHomepage, humanActionCopy } from '../wallet/appIdentity'
import { launchConnectedApp } from '../wallet/openAppInWalletBrowser'
import { playWalletSound } from '../wallet/soundService'
import { AppAvatar } from './AppAvatar'
import {
  formatPrimaryFromSats,
  formatSecondaryFromSats,
  getCachedUsdPerBsv,
} from '../wallet/fx'
import { getDisplayCurrency } from '../wallet/displayCurrency'
import type { AutoPayChoice } from '../wallet/autoPay'
import {
  AutoPayControls,
  connectPermissionNote,
  isBsvPaymentAction,
  useAutoPayForm,
} from './AutoPayControls'
import { ConnectScopesList } from './ConnectScopesList'
import { PermissionItemPreview } from './PermissionItemPreview'
import { permissionDecisionMachine } from '../machines/permissionDecisionMachine'
import { CheckIcon, CloseIcon } from './icons'
import { WalletRequestTemplate } from './WalletRequestTemplate'
import type { WalletDockActions } from './WalletActionDock'

type Props = {
  pending: PendingPrompt
  /** True only when this exact prompt was still current and accepted. */
  onAllow: (autoPay?: AutoPayChoice) => boolean
  /** True only when this exact prompt was still current and cancelled. */
  onDeny: () => boolean
  /** When `inline`, render Deny/Approve in the panel (desktop right column). */
  actions?: 'nav' | 'inline'
}

/**
 * Inline permission request — Activity tab (mobile, actions in nav) or
 * dashboard right column (desktop, actions in panel).
 */
export function PermissionRequestPanel({
  pending,
  onAllow,
  onDeny,
  actions = 'nav',
}: Props) {
  const [decision, sendDecision] = useMachine(permissionDecisionMachine)
  const decisionCommittedRef = useRef(false)
  const [iconReady, setIconReady] = useState(false)
  const [acceptIncoming, setAcceptIncoming] = useState(false)
  const autoPay = useAutoPayForm()
  const inlineActions = actions === 'inline'

  useEffect(() => {
    decisionCommittedRef.current = false
    sendDecision({ type: 'RESET' })
    setIconReady(false)
  }, [pending.id, pending.origin, sendDecision])

  useEffect(() => {
    autoPay.loadFromOrigin(pending.origin)
    if (pending.kind === 'action') {
      setAcceptIncoming(acceptsIncomingFunds(pending.origin))
    }
  }, [pending, autoPay.loadFromOrigin])

  const name = appDisplayName(pending.origin)
  const showAutoPay = pending.kind === 'connect' || isBsvPaymentAction(pending)
  const showAcceptIncoming =
    pending.kind === 'action' && pending.title === 'Accept incoming funds'
  const monthlyCap =
    pending.kind === 'connect' ? (pending.spendingAuthorization ?? null) : null
  const committing = decision.matches('committing')
  const allowDisabled =
    committing ||
    (showAutoPay && autoPay.enabled && !monthlyCap && autoPay.limitsInvalid)

  const runAllow = () => {
    if (decisionCommittedRef.current || !decision.matches('pending')) return
    decisionCommittedRef.current = true
    const accepted = !showAutoPay ? onAllow() : onAllow(autoPay.toChoice())
    if (accepted) {
      if (showAcceptIncoming) {
        setAcceptIncomingFunds(pending.origin, acceptIncoming)
      }
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

  const requestActions: WalletDockActions = {
    ariaLabel: 'Permission decision',
    secondary: {
      label: 'Cancel',
      onClick: runDeny,
      disabled: committing,
      icon: <CloseIcon size={18} />,
      tone: 'danger',
    },
    primary: {
      label: committing
        ? 'Approving…'
        : inlineActions
          ? pending.kind === 'connect'
            ? 'Authorize'
            : 'Approve'
          : 'Accept',
      onClick: runAllow,
      disabled: allowDisabled,
      autoFocus: true,
      icon: <CheckIcon size={18} />,
      tone: 'primary',
    },
  }

  const wrap = (scope: string, body: ReactNode) => (
    <WalletRequestTemplate
      scope={scope}
      state={iconReady ? 'pending' : 'loading'}
      actions={requestActions}
      placement={actions}
    >
      {body}
    </WalletRequestTemplate>
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
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  playWalletSound('soft')
                  launchConnectedApp(pending.origin, home)
                }}
              >
                Visit site
              </button>
            </>
          ) : null}
        </p>

        <ConnectScopesList />

        <AutoPayControls
          appName={name}
          enabled={autoPay.enabled}
          maxUsd={autoPay.maxUsd}
          windowHours={autoPay.windowHours}
          onEnabledChange={autoPay.setEnabled}
          onMaxUsdChange={autoPay.setMaxUsd}
          onWindowHoursChange={autoPay.setWindowHours}
          monthlyCap={monthlyCap}
        />

        <p className="permission-note">
          {connectPermissionNote(pending.spendingAuthorization, autoPay.enabled)}
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

      {showAcceptIncoming ? (
        <div className="auto-pay" data-aeon-part="accept-incoming">
          <label className="auto-pay-toggle">
            <input
              type="checkbox"
              checked={acceptIncoming}
              onChange={(event) => setAcceptIncoming(event.target.checked)}
            />
            <span>
              Accept funds automatically from <strong>{name}</strong>
            </span>
          </label>
        </div>
      ) : null}

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
        <AutoPayControls
          appName={name}
          enabled={autoPay.enabled}
          maxUsd={autoPay.maxUsd}
          windowHours={autoPay.windowHours}
          onEnabledChange={autoPay.setEnabled}
          onMaxUsdChange={autoPay.setMaxUsd}
          onWindowHoursChange={autoPay.setWindowHours}
        />
      ) : null}
    </>,
  )
}
