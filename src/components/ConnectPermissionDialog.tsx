import { useEffect, useRef, useState } from 'react'
import { Prompt } from '@aeon-ui/react'
import type { PendingPermission } from '../wallet/permissions'
import { CONNECT_SCOPES, appDisplayName, appHomepage } from '../wallet/appIdentity'
import {
  DEFAULT_AUTO_PAY_MAX_USD,
  DEFAULT_AUTO_PAY_WINDOW_HOURS,
  getAutoPaySettings,
} from '../wallet/autoPay'
import { formatSpendingAuthorizationLabel } from '../wallet/spendingAuthorization'
import { launchConnectedApp } from '../wallet/openAppInWalletBrowser'
import { playWalletSound } from '../wallet/soundService'
import type { AutoPayChoice } from './ActionPermissionDialog'
import { AppAvatar } from './AppAvatar'
import { ScopeIcon } from './ScopeIcon'
import { WalletActionBar } from './WalletActionBar'

type Props = {
  pending: PendingPermission | null
  /** Return false when the prompt was already gone / not applied. */
  onAllow: (autoPay?: AutoPayChoice) => boolean | void
  onDeny: () => void
}

/**
 * Chart projection: permission prompt open ↔ pending request.
 * Uses Aeon Prompt (portal, focus trap, escape) instead of a parallel ModalPortal.
 *
 * Authorize grants auto-accept of plain incoming BSV. Auto-pay is optional here
 * so the first outgoing payment can stay silent without a second redirect.
 */
export function ConnectPermissionDialog({ pending, onAllow, onDeny }: Props) {
  const [iconReady, setIconReady] = useState(false)
  const [autoEnabled, setAutoEnabled] = useState(false)
  const [maxUsd, setMaxUsd] = useState(String(DEFAULT_AUTO_PAY_MAX_USD))
  const [windowHours, setWindowHours] = useState(String(DEFAULT_AUTO_PAY_WINDOW_HOURS))
  const skipDenyRef = useRef(false)
  const open = Boolean(pending)
  const name = pending ? appDisplayName(pending.origin) : ''
  const home = pending ? appHomepage(pending.origin) : null
  const monthlyCap = Boolean(pending?.spendingAuthorization)

  useEffect(() => {
    setIconReady(false)
    if (!pending) return
    const existing = getAutoPaySettings(pending.origin)
    if (existing?.enabled) {
      setAutoEnabled(true)
      setMaxUsd(String(existing.maxUsd))
      setWindowHours(String(existing.windowHours))
    } else {
      setAutoEnabled(false)
      setMaxUsd(String(DEFAULT_AUTO_PAY_MAX_USD))
      setWindowHours(String(DEFAULT_AUTO_PAY_WINDOW_HOURS))
    }
  }, [pending?.origin, pending?.id])

  const parsedMaxUsd = Number.parseFloat(maxUsd)
  const parsedHours = Number.parseFloat(windowHours)
  const maxUsdValid = Number.isFinite(parsedMaxUsd) && parsedMaxUsd > 0
  const hoursValid = Number.isFinite(parsedHours) && parsedHours > 0
  const allowDisabled = autoEnabled && !monthlyCap && (!maxUsdValid || !hoursValid)

  const allow = () => {
    if (allowDisabled) return
    skipDenyRef.current = true
    const ok = onAllow({
      enabled: autoEnabled,
      maxUsd: maxUsdValid ? parsedMaxUsd : DEFAULT_AUTO_PAY_MAX_USD,
      windowHours: hoursValid ? Math.round(parsedHours) : DEFAULT_AUTO_PAY_WINDOW_HOURS,
    })
    if (ok === false) {
      skipDenyRef.current = false
    }
  }

  return (
    <div
      data-aeon-scope="connect-permission"
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
                className="panel modal permission-modal connect-permission-modal"
                data-aeon-state={iconReady ? 'ready' : 'loading'}
              >
                <div className="connect-app-hero">
                  <AppAvatar
                    origin={pending.origin}
                    name={name}
                    size="md"
                    onReady={() => setIconReady(true)}
                  />
                  <div>
                    <Prompt.Eyebrow className="permission-eyebrow">Connect</Prompt.Eyebrow>
                    <Prompt.Title>{name}</Prompt.Title>
                    <p className="connect-app-host mono">{pending.origin}</p>
                  </div>
                </div>

                <Prompt.Description className="lede permission-lede-compact">
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
                </Prompt.Description>

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

                  {autoEnabled && !monthlyCap ? (
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

                  {autoEnabled && monthlyCap && pending.spendingAuthorization ? (
                    <p className="permission-note" style={{ margin: 0 }}>
                      Within {formatSpendingAuthorizationLabel(pending.spendingAuthorization)}.
                    </p>
                  ) : null}
                </div>

                <p className="permission-note">
                  {pending.spendingAuthorization
                    ? `${formatSpendingAuthorizationLabel(pending.spendingAuthorization)}. ${
                        autoEnabled
                          ? 'Matching outgoing payments stay silent within that monthly cap.'
                          : 'Outgoing payments still need approval unless you enable Auto-pay.'
                      } Incoming plain BSV is accepted automatically. Disconnect anytime in Connected apps.`
                    : autoEnabled
                      ? 'Matching outgoing payments stay silent within your Auto-pay limits. Items still need separate approval. Incoming plain BSV is accepted automatically. Disconnect anytime in Connected apps.'
                      : 'Outgoing payments and items still need separate approval. Incoming plain BSV is accepted automatically. Disconnect anytime in Connected apps.'}
                </p>

                <WalletActionBar
                  ariaLabel="Connection decision"
                  className="connect-actions"
                  secondary={{ label: 'Deny', onClick: onDeny }}
                  primary={{
                    label: 'Authorize',
                    onClick: allow,
                    autoFocus: true,
                    disabled: allowDisabled,
                    tone: 'primary',
                  }}
                />
              </Prompt.Content>
            ) : null}
          </Prompt.Positioner>
        </Prompt.Portal>
      </Prompt.Root>
    </div>
  )
}
