import { useEffect, useRef, useState } from 'react'
import { Prompt } from '@aeon-ui/react'
import type { PendingPermission } from '../wallet/permissions'
import { CONNECT_SCOPES, appDisplayName, appHomepage } from '../wallet/appIdentity'
import { AppAvatar } from './AppAvatar'
import { ScopeIcon } from './ScopeIcon'

type Props = {
  pending: PendingPermission | null
  onAllow: () => void
  onDeny: () => void
}

/**
 * Chart projection: permission prompt open ↔ pending request.
 * Uses Aeon Prompt (portal, focus trap, escape) instead of a parallel ModalPortal.
 */
export function ConnectPermissionDialog({ pending, onAllow, onDeny }: Props) {
  const [iconReady, setIconReady] = useState(false)
  const skipDenyRef = useRef(false)
  const open = Boolean(pending)
  const name = pending ? appDisplayName(pending.origin) : ''
  const home = pending ? appHomepage(pending.origin) : null

  useEffect(() => {
    setIconReady(false)
  }, [pending?.origin, pending?.id])

  const allow = () => {
    skipDenyRef.current = true
    onAllow()
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
                      <a href={home} target="_blank" rel="noreferrer">
                        Visit site
                      </a>
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

                <p className="permission-note">
                  Payments and items still need separate approval. Disconnect anytime in Connected
                  apps.
                </p>

                <Prompt.Actions className="actions connect-actions">
                  <Prompt.Secondary className="btn btn-ghost" onClick={onDeny}>
                    Deny
                  </Prompt.Secondary>
                  <Prompt.Primary className="btn btn-primary" autoFocus onClick={allow}>
                    Authorize
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
