import { useEffect, useRef, useState } from 'react'
import { Prompt } from '@aeon-ui/react'
import type { PendingPermission } from '../wallet/permissions'
import { appDisplayName, appHomepage } from '../wallet/appIdentity'
import { launchConnectedApp } from '../wallet/openAppInWalletBrowser'
import { playWalletSound } from '../wallet/soundService'
import type { AutoPayChoice } from '../wallet/autoPay'
import {
  AutoPayControls,
  connectPermissionNote,
  useAutoPayForm,
  useLoadAutoPayOnOrigin,
} from './AutoPayControls'
import { AppAvatar } from './AppAvatar'
import { ConnectScopesList } from './ConnectScopesList'
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
  const autoPay = useAutoPayForm()
  const skipDenyRef = useRef(false)
  const open = Boolean(pending)
  const name = pending ? appDisplayName(pending.origin) : ''
  const home = pending ? appHomepage(pending.origin) : null
  const monthlyCap = pending?.spendingAuthorization ?? null

  useEffect(() => {
    setIconReady(false)
  }, [pending?.origin, pending?.id])

  useLoadAutoPayOnOrigin(pending?.origin, pending?.id, autoPay.loadFromOrigin)

  const allowDisabled = Boolean(autoPay.enabled && !monthlyCap && autoPay.limitsInvalid)

  const allow = () => {
    if (allowDisabled) return
    skipDenyRef.current = true
    const ok = onAllow(autoPay.toChoice())
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
